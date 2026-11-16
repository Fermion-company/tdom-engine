/* tdomfork.c — process-control bridge for stock LuaTeX (Lua 5.3 ABI).
 *
 * The checkpoint engine freezes TeX states by fork(): the parent process IS
 * the snapshot, children are alternative continuations. This shim exposes
 * the process and descriptor primitives that mechanism needs.
 *
 * Lua API symbols are resolved against the host luatex process at load time,
 * so no Lua headers or libraries are needed to build:
 *   macOS: cc -O2 -shared -undefined dynamic_lookup -o tdomfork.so tdomfork.c
 *   Linux: cc -O2 -shared -fPIC -o tdomfork.so tdomfork.c
 */

#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <dirent.h>
#include <poll.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <sys/resource.h>
#ifdef __APPLE__
#include <pthread/qos.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <sys/sysctl.h>
#endif

typedef struct lua_State lua_State;
typedef long long lua_Integer;
typedef int (*lua_CFunction)(lua_State *);

extern void lua_pushinteger(lua_State *L, lua_Integer n);
extern lua_Integer lua_tointegerx(lua_State *L, int idx, int *isnum);
extern const char *lua_tolstring(lua_State *L, int idx, size_t *len);
extern void lua_createtable(lua_State *L, int narr, int nrec);
extern void lua_pushcclosure(lua_State *L, lua_CFunction fn, int n);
extern void lua_pushboolean(lua_State *L, int value);
extern void lua_setfield(lua_State *L, int idx, const char *k);
extern const char *lua_pushlstring(lua_State *L, const char *s, size_t len);
extern void lua_pushnil(lua_State *L);
extern void lua_pushnumber(lua_State *L, double n);

/* The write end of the pipe on which this process hands a job to its spare
 * continuation (below). Only the process that forked the spare may hold it:
 * the spare ends when that end closes, so every other child drops it. */
static int spare_wfd = -1;

static void child_drops_spare(void) {
  if (spare_wfd >= 0) {
    close(spare_wfd);
    spare_wfd = -1;
  }
}

/* Checkpoint parents never consume child exit status. Re-assert that just
 * before every fork: a disposition set once at boot does not survive (the
 * census found ~4 zombies per keystroke under dormant checkpoints). */
static int discard_child_status(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_IGN;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_NOCLDWAIT;
  return sigaction(SIGCHLD, &sa, NULL);
}

static int l_fork(lua_State *L) {
  if (discard_child_status() != 0) { lua_pushinteger(L, -1); return 1; }
  pid_t pid = fork();
  if (pid == 0) child_drops_spare();
  lua_pushinteger(L, (lua_Integer)pid);
  return 1;
}

static int l_set_interactive(lua_State *L) {
  int result = 0;
#ifdef __APPLE__
  int interactive = lua_tointegerx(L, 1, NULL) != 0;
  result = pthread_set_qos_class_self_np(
    interactive ? QOS_CLASS_USER_INITIATED : QOS_CLASS_DEFAULT, 0);
#endif
  lua_pushboolean(L, result == 0);
  return 1;
}

/* Each resident continuation owns its PDF bytes as well as the backend's
 * in-memory object table. Anonymous files are reclaimed with the process;
 * checkpoint retirement needs no path bookkeeping. */
static int copy_pdf_fd(int source, int output) {
  char buffer[65536];
  off_t at = 0;
  for (;;) {
    ssize_t n = pread(source, buffer, sizeof(buffer), at);
    if (n == 0) break;
    if (n < 0) { if (errno == EINTR) continue; return 0; }
    ssize_t written = 0;
    while (written < n) {
      ssize_t k = write(output, buffer + written, (size_t)(n - written));
      if (k < 0 && errno == EINTR) continue;
      if (k <= 0) return 0;
      written += k;
    }
    at += n;
  }
  off_t offset = lseek(source, 0, SEEK_CUR);
  return offset >= 0 && lseek(output, offset, SEEK_SET) >= 0;
}

static int l_fork_pdf(lua_State *L) {
  int fd = (int)lua_tointegerx(L, 1, NULL);
  if (fflush(NULL) != 0) { lua_pushinteger(L, -1); return 1; }
  /* Prepare before fork: a failed copy is an ordinary FORKFAIL, and the
   * parent never receives a child that still shares writable PDF state. */
  FILE *private_file = tmpfile();
  if (!private_file || !copy_pdf_fd(fd, fileno(private_file))) {
    if (private_file) fclose(private_file);
    lua_pushinteger(L, -1);
    return 1;
  }
  if (discard_child_status() != 0) {
    fclose(private_file);
    lua_pushinteger(L, -1);
    return 1;
  }
  pid_t pid = fork();
  if (pid == 0 && dup2(fileno(private_file), fd) < 0) _exit(125);
  if (pid == 0) child_drops_spare();
  fclose(private_file);
  lua_pushinteger(L, (lua_Integer)pid);
  return 1;
}

/* ---- pages a continuation reads -------------------------------------
 *
 * A forked child starts with an empty page table: every page it reads of
 * the memory it shares with its parent is a fault, and the fault walks the
 * chain of copy-on-write generations behind the page (1.7 us a page one
 * generation deep, 15 us at 400). A three-line paragraph of a 389-page book
 * read 66 MB that way: 4,400 faults, 557 of them copies, 5 ms of kernel time
 * in a job whose own work is 1.5 ms once its fonts are there.
 *
 * So a job that has run says which pages its page table holds, and a spare
 * continuation (below), forked ahead of the next keystroke, reads one byte
 * of each while it waits. Reading shared memory changes nothing in it; the
 * list is advice from a sibling process, so every address is checked against
 * this process's own map before it is read. */

#define HINT_RUNS 49152
#define HINT_FONT_TEXT 16384
typedef struct {
  volatile uint32_t seq; /* odd while a job is writing the list */
  uint32_t count;
  double stamp;          /* when it was written (wall_ms) */
  long long tag;         /* what the job was (the caller's number: its checkpoint) */
  uint64_t runs[HINT_RUNS]; /* page address | (pages in the run - 1) */
  /* the fonts the last job at one point of the document had to load (text
   * the caller makes and reads; fonts_put / fonts_get) */
  volatile uint32_t font_seq; /* odd while being written */
  uint32_t font_len;
  long long font_tag;
  long long font_refused; /* a point whose fonts cannot be loaded ahead (fonts_put(tag, false)); 0: none */
  char font_text[HINT_FONT_TEXT];
} hint_table;

static hint_table *hints;              /* one for the whole lineage (MAP_SHARED, made in the root) */
static uint64_t hint_copy[HINT_RUNS];  /* this process's copy while it works on the list */
static uint32_t hint_seen;             /* the list this process has read */
static volatile unsigned long hint_sink;

static int has_input_fd(int fd) {
  struct pollfd waiting = { fd, POLLIN, 0 };
  return fd >= 0 && poll(&waiting, 1, 0) > 0;
}

static double wall_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}

#ifdef __APPLE__
/* Region and page queries about one's own task answer from the page table,
 * not from the memory objects, while this is set (the footprint tools' view). */
static int own_pages_view(int on, int *was) {
  size_t len = sizeof(*was);
  return sysctlbyname("vm.self_region_footprint", was, was ? &len : NULL, &on, sizeof(on)) == 0;
}

/* The pages of this process's page table in its own writable memory (its
 * heap and data: what the page table view counts), as runs in hint_copy.
 * Returns the number of runs; `*stopped` is set, and the listing abandoned,
 * as soon as `stop_fd` has something to read.
 *
 * (Which of them the job WROTE is not asked. A page's own record says it,
 * but reading that record locks the memory objects the whole lineage
 * shares, once per page and generation: 89 forks deep, one listing took a
 * second and every job, spare and render of the document waited on those
 * locks meanwhile. The copies a job makes of the pages it writes stay with
 * the job.) */
static uint32_t own_page_runs(unsigned long *pages, int stop_fd, int *stopped) {
  static int dispositions[4096];
  const mach_vm_size_t page = (mach_vm_size_t)getpagesize();
  const uint64_t mask = (uint64_t)page - 1;
  mach_vm_address_t addr = 0;
  uint32_t count = 0;
  uint64_t run = 0, run_pages = 0;
  for (;;) {
    mach_vm_size_t size = 0;
    vm_region_basic_info_data_64_t info;
    mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object = MACH_PORT_NULL;
    if (mach_vm_region(mach_task_self(), &addr, &size, VM_REGION_BASIC_INFO_64, (vm_region_info_t)&info,
                       &info_count, &object) != KERN_SUCCESS) break;
    if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
    const int wanted = (info.protection & VM_PROT_READ) && (info.protection & VM_PROT_WRITE) && !info.shared;
    for (mach_vm_size_t off = 0; wanted && off < size; off += page * 4096) {
      if (has_input_fd(stop_fd)) {
        *stopped = 1;
        return 0;
      }
      mach_vm_size_t slice = size - off < page * 4096 ? size - off : page * 4096;
      mach_vm_size_t n = slice / page;
      if (mach_vm_page_range_query(mach_task_self(), addr + off, slice, (mach_vm_address_t)dispositions, &n) !=
          KERN_SUCCESS) break;
      for (mach_vm_size_t i = 0; i < n; i++) {
        if (!(dispositions[i] & VM_PAGE_QUERY_PAGE_PRESENT)) continue;
        const uint64_t at = (uint64_t)(addr + off + i * page);
        (*pages)++;
        if (run_pages && at == run + run_pages * page && run_pages <= mask) {
          run_pages++;
          continue;
        }
        if (run_pages && count < HINT_RUNS) hint_copy[count++] = run | (run_pages - 1);
        run = at;
        run_pages = 1;
      }
    }
    addr += size;
  }
  if (run_pages && count < HINT_RUNS) hint_copy[count++] = run | (run_pages - 1);
  return count;
}
#endif

static int l_hints_init(lua_State *L) {
  int ok = 0;
#ifdef __APPLE__
  if (!hints) {
    void *table = mmap(NULL, sizeof(hint_table), PROT_READ | PROT_WRITE, MAP_ANON | MAP_SHARED, -1, 0);
    if (table != MAP_FAILED) hints = (hint_table *)table;
  }
  int was = 0;
  ok = hints != NULL && own_pages_view(1, &was) && own_pages_view(was, NULL);
#endif
  lua_pushboolean(L, ok);
  return 1;
}

/* hints_record(tag, min_age_ms, stop_fd): write down the pages this
 * process's page table holds in its own writable memory.
 * Left alone when the list in hand is of the same tag and younger than
 * min_age_ms (one paragraph's keystrokes read the same pages).
 * Returns pages, runs, milliseconds; nothing when it left the list alone;
 * false when `stop_fd` had something to read first (ask again later). */
static int l_hints_record(lua_State *L) {
#ifdef __APPLE__
  const long long tag = lua_tointegerx(L, 1, NULL);
  const double min_age = (double)lua_tointegerx(L, 2, NULL);
  int isnum = 0;
  const int given = (int)lua_tointegerx(L, 3, &isnum);
  const int stop_fd = isnum ? given : -1;
  int was = 0, stopped = 0;
  if (!hints) return 0;
  const double started = wall_ms();
  if (hints->tag == tag && hints->count > 0 && started - hints->stamp < min_age) return 0;
  const uint32_t seq = hints->seq;
  if (seq & 1) return 0; /* another job is writing */
  unsigned long pages = 0;
  uint32_t found = 0;
  if (own_pages_view(1, &was)) {
    found = own_page_runs(&pages, stop_fd, &stopped);
    own_pages_view(was, NULL);
  }
  if (stopped) {
    lua_pushboolean(L, 0);
    return 1;
  }
  if (!found || !__sync_bool_compare_and_swap(&hints->seq, seq, seq + 1)) return 0;
  memcpy(hints->runs, hint_copy, (size_t)found * sizeof(uint64_t));
  hints->count = found;
  hints->tag = tag;
  hints->stamp = wall_ms();
  hints->seq = seq + 2;
  lua_pushinteger(L, (lua_Integer)pages);
  lua_pushinteger(L, (lua_Integer)found);
  lua_pushnumber(L, wall_ms() - started);
  return 3;
#else
  (void)L;
  return 0;
#endif
}

/* Read one byte of every listed page that lies in memory this process may
 * read. Stops as soon as `stop_fd` has something to read. Returns the pages
 * read, or -1 when there was no new list. */
static long touch_hints(int stop_fd) {
#ifdef __APPLE__
  if (!hints) return -1;
  const uint32_t seq = hints->seq;
  if ((seq & 1) || seq == hint_seen) return -1;
  const uint32_t count = hints->count;
  if (count > HINT_RUNS) return -1;
  memcpy(hint_copy, hints->runs, (size_t)count * sizeof(uint64_t));
  if (hints->seq != seq) return -1; /* rewritten meanwhile: the next look takes it */
  hint_seen = seq;
  const uint64_t page = (uint64_t)getpagesize();
  const uint64_t mask = page - 1;
  uint64_t region_start = 0, region_end = 0;
  int readable = 0;
  long touched = 0;
  unsigned long sum = 0;
  for (uint32_t i = 0; i < count; i++) {
    uint64_t at = hint_copy[i] & ~mask;
    const uint64_t end = at + ((hint_copy[i] & mask) + 1) * page;
    while (at < end) {
      if (at < region_start || at >= region_end) {
        mach_vm_address_t addr = (mach_vm_address_t)at;
        mach_vm_size_t size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        if (mach_vm_region(mach_task_self(), &addr, &size, VM_REGION_BASIC_INFO_64, (vm_region_info_t)&info,
                           &info_count, &object) != KERN_SUCCESS) break; /* nothing mapped from here on */
        if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
        region_start = (uint64_t)addr;
        region_end = (uint64_t)addr + (uint64_t)size;
        readable = (info.protection & VM_PROT_READ) != 0;
        if (at < region_start) { /* a hole: go on at the next mapped address */
          at = region_start;
          continue;
        }
      }
      const uint64_t stop = end < region_end ? end : region_end;
      if (readable) {
        for (; at < stop; at += page) {
          sum += *(volatile const unsigned char *)(uintptr_t)at;
          if ((++touched & 255) == 0 && has_input_fd(stop_fd)) {
            hint_sink = sum;
            return touched;
          }
        }
      }
      at = stop;
    }
  }
  hint_sink = sum;
  return touched;
#else
  (void)stop_fd;
  return -1;
#endif
}

/* fonts_put(tag, text): leave `text` for the spares of the point `tag`.
 * False when it does not fit, another job is writing, or the point is one
 * whose fonts cannot be loaded ahead. fonts_put(tag, false) makes it one
 * (until another point is) and takes its text away. */
static int l_fonts_put(lua_State *L) {
  int ok = 0;
  if (hints) {
    const long long tag = lua_tointegerx(L, 1, NULL);
    size_t len = 0;
    const char *text = lua_tolstring(L, 2, &len);
    const uint32_t seq = hints->font_seq;
    if (!text) {
      hints->font_refused = tag;
      text = "";
      len = 0;
    } else if (hints->font_refused == tag) {
      lua_pushboolean(L, 0);
      return 1;
    }
    if (len <= HINT_FONT_TEXT && !(seq & 1) && __sync_bool_compare_and_swap(&hints->font_seq, seq, seq + 1)) {
      memcpy(hints->font_text, text, len);
      hints->font_len = (uint32_t)len;
      hints->font_tag = tag;
      hints->font_seq = seq + 2;
      ok = 1;
    }
  }
  lua_pushboolean(L, ok);
  return 1;
}

/* Whether a text for `tag` other than the one numbered `seen` is there. */
static int fonts_waiting(long long tag, uint32_t seen) {
  if (!hints) return 0;
  const uint32_t seq = hints->font_seq;
  return !(seq & 1) && seq != seen && hints->font_tag == tag && hints->font_len > 0;
}

/* fonts_get(tag, seen): the text left for `tag` and its number, unless it
 * is the one numbered `seen` (or there is none). */
static int l_fonts_get(lua_State *L) {
  static char copy[HINT_FONT_TEXT];
  const long long tag = lua_tointegerx(L, 1, NULL);
  const uint32_t seen = (uint32_t)lua_tointegerx(L, 2, NULL);
  if (!fonts_waiting(tag, seen)) return 0;
  const uint32_t seq = hints->font_seq;
  const uint32_t len = hints->font_len;
  if (len > HINT_FONT_TEXT) return 0;
  memcpy(copy, hints->font_text, len);
  if (hints->font_seq != seq || hints->font_tag != tag) return 0; /* rewritten meanwhile */
  lua_pushlstring(L, copy, len);
  lua_pushinteger(L, (lua_Integer)seq);
  return 2;
}

/* usage(): what this process has spent so far — user ms, system ms, page
 * faults, copy-on-write faults (diagnostics: where a job's time goes). */
static int l_usage(lua_State *L) {
  struct rusage used;
  memset(&used, 0, sizeof(used));
  getrusage(RUSAGE_SELF, &used);
  lua_pushnumber(L, used.ru_utime.tv_sec * 1000.0 + used.ru_utime.tv_usec / 1000.0);
  lua_pushnumber(L, used.ru_stime.tv_sec * 1000.0 + used.ru_stime.tv_usec / 1000.0);
  long long faults = (long long)used.ru_minflt + (long long)used.ru_majflt, cow = -1;
#ifdef __APPLE__
  task_events_info_data_t events;
  mach_msg_type_number_t count = TASK_EVENTS_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_EVENTS_INFO, (task_info_t)&events, &count) == KERN_SUCCESS) {
    faults = events.faults;
    cow = events.cow_faults;
  }
#endif
  lua_pushinteger(L, (lua_Integer)faults);
  lua_pushinteger(L, (lua_Integer)cow);
  return 4;
}

/* wait_readable(fd, ms): whether fd has something to read within ms. */
static int l_wait_readable(lua_State *L) {
  struct pollfd waiting = { (int)lua_tointegerx(L, 1, NULL), POLLIN, 0 };
  int ready = poll(&waiting, 1, (int)lua_tointegerx(L, 2, NULL));
  lua_pushboolean(L, ready != 0); /* (an error counts as "do not wait here") */
  return 1;
}

/* ---- a spare continuation --------------------------------------------
 *
 * spare_fork: like fork_pdf, with a pipe from parent to child. The child
 * (returns 0 and the pipe's read end) is the same continuation a job would
 * be forked into, made before the job exists. It waits in spare_wait,
 * reading the pages the last job read, until the parent sends the job with
 * spare_send or goes away. The parent gets the pid. */
static int l_spare_fork(lua_State *L) {
  int fd = (int)lua_tointegerx(L, 1, NULL);
  int ends[2];
  child_drops_spare(); /* one spare at a time: an earlier one ends here */
  if (fflush(NULL) != 0 || pipe(ends) != 0) { lua_pushinteger(L, -1); return 1; }
  fcntl(ends[0], F_SETFD, FD_CLOEXEC);
  fcntl(ends[1], F_SETFD, FD_CLOEXEC);
  FILE *private_file = tmpfile();
  if (!private_file || !copy_pdf_fd(fd, fileno(private_file)) || discard_child_status() != 0) {
    if (private_file) fclose(private_file);
    close(ends[0]);
    close(ends[1]);
    lua_pushinteger(L, -1);
    return 1;
  }
  pid_t pid = fork();
  if (pid == 0 && dup2(fileno(private_file), fd) < 0) _exit(125);
  fclose(private_file);
  if (pid == 0) {
    close(ends[1]);
    hint_seen = 0; /* (the parent may have been a spare that read this very list) */
    lua_pushinteger(L, 0);
    lua_pushinteger(L, (lua_Integer)ends[0]);
    return 2;
  }
  close(ends[0]);
  if (pid < 0) {
    close(ends[1]);
    lua_pushinteger(L, -1);
    return 1;
  }
  spare_wfd = ends[1];
  lua_pushinteger(L, (lua_Integer)pid);
  return 1;
}

static int l_spare_drop(lua_State *L) {
  (void)L;
  child_drops_spare();
  return 0;
}

static int write_all(int fd, const char *data, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, data, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    data += n;
    len -= (size_t)n;
  }
  return 1;
}

/* Hand the spare its job. False when there is no spare or it is gone: the
 * caller forks an ordinary child instead. The spare is used up either way. */
static int l_spare_send(lua_State *L) {
  size_t len = 0;
  const char *data = lua_tolstring(L, 1, &len);
  int ok = 0;
  if (spare_wfd >= 0 && data && len <= UINT32_MAX) {
    struct sigaction ignore, before;
    memset(&ignore, 0, sizeof(ignore));
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    sigaction(SIGPIPE, &ignore, &before); /* a spare that died is no reason to */
    uint32_t size = (uint32_t)len;
    ok = write_all(spare_wfd, (const char *)&size, sizeof(size)) && write_all(spare_wfd, data, len);
    sigaction(SIGPIPE, &before, NULL);
  }
  child_drops_spare();
  lua_pushboolean(L, ok);
  return 1;
}

static int read_all(int fd, char *data, size_t len) {
  while (len > 0) {
    ssize_t n = read(fd, data, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    data += n;
    len -= (size_t)n;
  }
  return 1;
}

/* spare_wait(fd, tag, seen): in the spare, read the hinted pages, then sleep
 * until the job arrives and return it (and how many pages were read, how
 * long that took). Returns false instead as soon as a font list for `tag`
 * other than the one numbered `seen` is there and no job is: the caller
 * loads the fonts and waits again. The parent closing its end, or dying,
 * ends this process. */
static int l_spare_wait(lua_State *L) {
  int fd = (int)lua_tointegerx(L, 1, NULL);
  const long long tag = lua_tointegerx(L, 2, NULL);
  const uint32_t seen = (uint32_t)lua_tointegerx(L, 3, NULL);
  long touched = 0;
  double spent = 0;
  int looks = 0;
  for (;;) {
    if (!has_input_fd(fd) && fonts_waiting(tag, seen)) {
      lua_pushboolean(L, 0);
      return 1;
    }
    double started = wall_ms();
    long n = touch_hints(fd);
    if (n > 0) {
      touched += n;
      spent += wall_ms() - started;
    }
    struct pollfd waiting = { fd, POLLIN, 0 };
    /* the job in flight when this spare was made writes its list shortly:
     * look again a few times, then sleep until the job */
    int ready = poll(&waiting, 1, looks < 24 ? 12 : -1);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) _exit(0);
    if (ready == 0) {
      looks++;
      continue;
    }
    uint32_t size = 0;
    if (!read_all(fd, (char *)&size, sizeof(size))) _exit(0);
    char *data = (char *)malloc(size ? size : 1);
    if (!data || !read_all(fd, data, size)) _exit(0);
    close(fd);
    lua_pushlstring(L, data, size);
    free(data);
    lua_pushinteger(L, (lua_Integer)touched);
    lua_pushnumber(L, spent);
    return 3;
  }
}

static int l_publish_pdf(lua_State *L) {
  int fd = (int)lua_tointegerx(L, 1, NULL);
  const char *target = lua_tolstring(L, 2, NULL);
  int output = target ? open(target, O_RDWR | O_CREAT | O_TRUNC, 0600) : -1;
  int ok = output >= 0 && fflush(NULL) == 0 && copy_pdf_fd(fd, output) && dup2(output, fd) >= 0;
  if (output >= 0) close(output);
  lua_pushboolean(L, ok);
  return 1;
}

static int l_getpid(lua_State *L) {
  lua_pushinteger(L, (lua_Integer)getpid());
  return 1;
}

static int l_waitpid(lua_State *L) {
  int status = 0;
  pid_t pid = waitpid((pid_t)lua_tointegerx(L, 1, 0), &status, 0);
  lua_pushinteger(L, (lua_Integer)pid);
  lua_pushinteger(L, (lua_Integer)status);
  return 2;
}

static int l_exit(lua_State *L) {
  _exit((int)lua_tointegerx(L, 1, 0));
  return 0;
}

/* Checkpoint parents never wait for their (long-lived) children; ignore
 * SIGCHLD so exited render children do not accumulate as zombies. */
static int l_ignore_sigchld(lua_State *L) {
  (void)L;
  discard_child_status();
  return 0;
}

static int fd_matches_path(int fd, const char *wanted) {
  char actual[PATH_MAX];
#if defined(__APPLE__) && defined(F_GETPATH)
  if (fcntl(fd, F_GETPATH, actual) != 0) return 0;
#elif defined(__linux__)
  char link[64];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, actual, sizeof(actual) - 1);
  if (n < 0) return 0;
  actual[n] = '\0';
#else
  (void)fd; (void)wanted;
  return 0;
#endif
  char resolved_actual[PATH_MAX];
  const char *left = realpath(actual, resolved_actual) ? resolved_actual : actual;
  return strcmp(left, wanted) == 0;
}

static int fd_matches_access(int fd, const char *source, int writable) {
  int flags = fcntl(fd, F_GETFL);
  if (flags == -1) return 0;
  if (writable ? (flags & O_ACCMODE) == O_RDONLY : (flags & O_ACCMODE) == O_WRONLY) return 0;
  return fd_matches_path(fd, source);
}

static int find_file_fd(const char *source, int writable) {
  char resolved[PATH_MAX];
  const char *wanted = realpath(source, resolved) ? resolved : source;
#if defined(__APPLE__) || defined(__linux__)
#if defined(__APPLE__)
  DIR *descriptors = opendir("/dev/fd");
#else
  DIR *descriptors = opendir("/proc/self/fd");
#endif
  if (descriptors) {
    int found = -1;
    struct dirent *entry;
    // Enumerate afresh: TeX can close and reuse descriptors between jobs.
    // Probing the entire descriptor limit for every absent aux extension
    // makes a page checkpoint pay thousands of failed system calls.
    while ((entry = readdir(descriptors)) != NULL) {
      char *end;
      long fd = strtol(entry->d_name, &end, 10);
      if (end == entry->d_name || *end || fd < 3 || fd > INT_MAX) continue;
      if (found >= 0 && fd >= found) continue;
      if (fd_matches_access((int)fd, wanted, writable)) found = (int)fd;
    }
    closedir(descriptors);
    return found;
  }
#endif
  long max_fd = sysconf(_SC_OPEN_MAX);
  if (max_fd < 0 || max_fd > 4096) max_fd = 4096;
  for (int fd = 3; fd < max_fd; fd++) {
    if (fd_matches_access(fd, wanted, writable)) return fd;
  }
  return -1;
}

static int find_writable_fd(const char *source) {
  return find_file_fd(source, 1);
}

static int l_prepare_pdf(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  int fd = source ? find_writable_fd(source) : -1;
  int readable = source && fflush(NULL) == 0 ? open(source, O_RDWR) : -1;
  off_t offset = fd >= 0 ? lseek(fd, 0, SEEK_CUR) : -1;
  int ok = readable >= 0 && offset >= 0 && lseek(readable, offset, SEEK_SET) >= 0 && dup2(readable, fd) >= 0;
  if (readable >= 0) close(readable);
  lua_pushinteger(L, ok ? fd : -1);
  return 1;
}

static int find_readable_fd(const char *source) {
  return find_file_fd(source, 0);
}

static int copy_path(const char *source, const char *target) {
  int input = open(source, O_RDONLY);
  int output = open(target, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (input < 0 || output < 0) {
    if (input >= 0) close(input);
    if (output >= 0) close(output);
    return 0;
  }
  char buffer[65536];
  int ok = 1;
  for (;;) {
    ssize_t read_count = read(input, buffer, sizeof(buffer));
    if (read_count == 0) break;
    if (read_count < 0) {
      if (errno == EINTR) continue;
      ok = 0;
      break;
    }
    ssize_t written = 0;
    while (written < read_count) {
      ssize_t count = write(output, buffer + written, (size_t)(read_count - written));
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) { ok = 0; break; }
      written += count;
    }
    if (!ok) break;
  }
  close(input);
  close(output);
  return ok;
}

static int redirect_fd_to_path(int source_fd, const char *target) {
  int output = open(target, O_WRONLY);
  if (output < 0) return 0;
  off_t offset = lseek(source_fd, 0, SEEK_CUR);
  int ok = offset >= 0 && lseek(output, offset, SEEK_SET) >= 0 && dup2(output, source_fd) >= 0;
  close(output);
  return ok;
}

/* Clone an already-open output file and redirect the SAME descriptor to the
 * clone. The host's FILE* and LuaTeX PDF backend keep their buffered state;
 * after fork they simply flush/continue into a private inode. This is what
 * makes page-boundary checkpoints compatible with hyperref opening the PDF
 * before the first shipout. Returns false when the source is not open yet. */
static int l_clone_open_fd(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  const char *target = lua_tolstring(L, 2, NULL);
  if (!source || !target) {
    lua_pushboolean(L, 0);
    return 1;
  }
  int source_fd = find_writable_fd(source);
  if (source_fd < 0) {
    lua_pushboolean(L, 0);
    return 1;
  }
  /* LuaTeX writes through buffered stdio. A path-level copy made before
   * fflush can omit objects that the backend already considers emitted;
   * the child would then finalize a structurally valid-looking PDF with
   * missing resources. Empty every inherited FILE buffer before cloning. */
  int ok = fflush(NULL) == 0 && copy_path(source, target) && redirect_fd_to_path(source_fd, target);
  lua_pushboolean(L, ok);
  return 1;
}

static int l_copy_open_fd(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  const char *target = lua_tolstring(L, 2, NULL);
  int ok = source && target && find_writable_fd(source) >= 0 &&
           fflush(NULL) == 0 && copy_path(source, target);
  lua_pushboolean(L, ok);
  return 1;
}

static int l_redirect_open_fd(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  const char *target = lua_tolstring(L, 2, NULL);
  int source_fd = source ? find_writable_fd(source) : -1;
  int ok = source_fd >= 0 && target && redirect_fd_to_path(source_fd, target);
  lua_pushboolean(L, ok);
  return 1;
}

/* Freeze a private continuation for an active TeX input stream. stdio may
 * already have prefetched bytes, so the kernel offset is ahead of the logical
 * scanner position. That is exactly what we need: the FILE buffer is copied
 * by fork(), and this independent descriptor starts where that copied buffer
 * will need its next refill. Preparing it BEFORE fork prevents the parent
 * from racing the child's adoption by advancing the shared open-file offset. */
static int l_prepare_read_fd(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  int source_fd = source ? find_readable_fd(source) : -1;
  int prepared = -1;
  if (source_fd >= 0) {
    off_t offset = lseek(source_fd, 0, SEEK_CUR);
    prepared = open(source, O_RDONLY);
    if (offset < 0 || prepared < 0 || lseek(prepared, offset, SEEK_SET) < 0) {
      if (prepared >= 0) close(prepared);
      prepared = -1;
    }
  }
  lua_pushinteger(L, (lua_Integer)prepared);
  return 1;
}

static int l_adopt_read_fd(lua_State *L) {
  const char *source = lua_tolstring(L, 1, NULL);
  int prepared = (int)lua_tointegerx(L, 2, NULL);
  int source_fd = source ? find_readable_fd(source) : -1;
  int ok = source_fd >= 0 && prepared >= 0 && dup2(prepared, source_fd) >= 0;
  if (prepared >= 0 && prepared != source_fd) close(prepared);
  lua_pushboolean(L, ok);
  return 1;
}

static int l_close_fd(lua_State *L) {
  int fd = (int)lua_tointegerx(L, 1, NULL);
  lua_pushboolean(L, fd < 0 || close(fd) == 0);
  return 1;
}

static int l_flush(lua_State *L) {
  lua_pushboolean(L, fflush(NULL) == 0);
  return 1;
}

int luaopen_tdomfork(lua_State *L) {
  lua_createtable(L, 0, 24);
  lua_pushcclosure(L, l_fork, 0);
  lua_setfield(L, -2, "fork");
  lua_pushcclosure(L, l_set_interactive, 0);
  lua_setfield(L, -2, "set_interactive");
  lua_pushcclosure(L, l_getpid, 0);
  lua_setfield(L, -2, "getpid");
  lua_pushcclosure(L, l_waitpid, 0);
  lua_setfield(L, -2, "waitpid");
  lua_pushcclosure(L, l_exit, 0);
  lua_setfield(L, -2, "_exit");
  lua_pushcclosure(L, l_ignore_sigchld, 0);
  lua_setfield(L, -2, "ignore_sigchld");
  lua_pushcclosure(L, l_clone_open_fd, 0);
  lua_setfield(L, -2, "clone_open_fd");
  lua_pushcclosure(L, l_copy_open_fd, 0);
  lua_setfield(L, -2, "copy_open_fd");
  lua_pushcclosure(L, l_prepare_pdf, 0);
  lua_setfield(L, -2, "prepare_pdf");
  lua_pushcclosure(L, l_fork_pdf, 0);
  lua_setfield(L, -2, "fork_pdf");
  lua_pushcclosure(L, l_publish_pdf, 0);
  lua_setfield(L, -2, "publish_pdf");
  lua_pushcclosure(L, l_redirect_open_fd, 0);
  lua_setfield(L, -2, "redirect_open_fd");
  lua_pushcclosure(L, l_prepare_read_fd, 0);
  lua_setfield(L, -2, "prepare_read_fd");
  lua_pushcclosure(L, l_adopt_read_fd, 0);
  lua_setfield(L, -2, "adopt_read_fd");
  lua_pushcclosure(L, l_close_fd, 0);
  lua_setfield(L, -2, "close_fd");
  lua_pushcclosure(L, l_flush, 0);
  lua_setfield(L, -2, "flush");
  lua_pushcclosure(L, l_hints_init, 0);
  lua_setfield(L, -2, "hints_init");
  lua_pushcclosure(L, l_hints_record, 0);
  lua_setfield(L, -2, "hints_record");
  lua_pushcclosure(L, l_wait_readable, 0);
  lua_setfield(L, -2, "wait_readable");
  lua_pushcclosure(L, l_usage, 0);
  lua_setfield(L, -2, "usage");
  lua_pushcclosure(L, l_fonts_put, 0);
  lua_setfield(L, -2, "fonts_put");
  lua_pushcclosure(L, l_fonts_get, 0);
  lua_setfield(L, -2, "fonts_get");
  lua_pushcclosure(L, l_spare_fork, 0);
  lua_setfield(L, -2, "spare_fork");
  lua_pushcclosure(L, l_spare_drop, 0);
  lua_setfield(L, -2, "spare_drop");
  lua_pushcclosure(L, l_spare_send, 0);
  lua_setfield(L, -2, "spare_send");
  lua_pushcclosure(L, l_spare_wait, 0);
  lua_setfield(L, -2, "spare_wait");
  return 1;
}
