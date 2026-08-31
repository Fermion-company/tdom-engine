/* tdomfork.c — process-control bridge for stock LuaTeX (Lua 5.3 ABI).
 *
 * The checkpoint engine freezes TeX states by fork(): the parent process IS
 * the snapshot, children are alternative continuations. This shim exposes
 * exactly the four primitives that mechanism needs.
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

static int l_fork(lua_State *L) {
  lua_pushinteger(L, (lua_Integer)fork());
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
  signal(SIGCHLD, SIG_IGN);
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
  char resolved_wanted[PATH_MAX];
  const char *left = realpath(actual, resolved_actual) ? resolved_actual : actual;
  const char *right = realpath(wanted, resolved_wanted) ? resolved_wanted : wanted;
  return strcmp(left, right) == 0;
}

static int find_writable_fd(const char *source) {
  long max_fd = sysconf(_SC_OPEN_MAX);
  if (max_fd < 0 || max_fd > 4096) max_fd = 4096;
  for (int fd = 3; fd < max_fd; fd++) {
    if (fcntl(fd, F_GETFD) == -1 || !fd_matches_path(fd, source)) continue;
    int flags = fcntl(fd, F_GETFL);
    if (flags != -1 && (flags & O_ACCMODE) != O_RDONLY) return fd;
  }
  return -1;
}

static int find_readable_fd(const char *source) {
  long max_fd = sysconf(_SC_OPEN_MAX);
  if (max_fd < 0 || max_fd > 4096) max_fd = 4096;
  for (int fd = 3; fd < max_fd; fd++) {
    if (fcntl(fd, F_GETFD) == -1 || !fd_matches_path(fd, source)) continue;
    int flags = fcntl(fd, F_GETFL);
    if (flags != -1 && (flags & O_ACCMODE) != O_WRONLY) return fd;
  }
  return -1;
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

int luaopen_tdomfork(lua_State *L) {
  lua_createtable(L, 0, 8);
  lua_pushcclosure(L, l_fork, 0);
  lua_setfield(L, -2, "fork");
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
  lua_pushcclosure(L, l_redirect_open_fd, 0);
  lua_setfield(L, -2, "redirect_open_fd");
  lua_pushcclosure(L, l_prepare_read_fd, 0);
  lua_setfield(L, -2, "prepare_read_fd");
  lua_pushcclosure(L, l_adopt_read_fd, 0);
  lua_setfield(L, -2, "adopt_read_fd");
  lua_pushcclosure(L, l_close_fd, 0);
  lua_setfield(L, -2, "close_fd");
  return 1;
}
