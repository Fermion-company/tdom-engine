#include "synctex_parser.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

#define MAX_LINES 512
#define MAX_RECORDS 100000

static int parse_positive_int(const char *text, int *value) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || parsed < 1 || parsed > 2147483647L) return 0;
  *value = (int)parsed;
  return 1;
}

int main(int argc, char **argv) {
  int first = 0, last = 0, first_column = 0;
  if (argc != 6 || !parse_positive_int(argv[3], &first) ||
      !parse_positive_int(argv[4], &last) || !parse_positive_int(argv[5], &first_column) ||
      last < first || last - first >= MAX_LINES) return 2;

  synctex_scanner_p scanner = synctex_scanner_new_with_output_file(argv[1], NULL, 1);
  if (!scanner) return 3;

  size_t total_records = 0;
  fputs("{\"schemaVersion\":1,\"groups\":[", stdout);
  for (int offset = 0; offset <= last - first; offset++) {
    const int line = first + offset;
    if (offset != 0) fputc(',', stdout);
    printf("{\"line\":%d,\"records\":[", line);
    const int column = line == first ? first_column : 1;
    const synctex_status_t count = synctex_display_query(scanner, argv[2], line, column, 0);
    if (count < 0) {
      synctex_scanner_free(scanner);
      return 4;
    }
    int first_record = 1;
    synctex_node_p node = NULL;
    while ((node = synctex_scanner_next_result(scanner))) {
      if (++total_records > MAX_RECORDS) {
        synctex_scanner_free(scanner);
        return 5;
      }
      if (!first_record) fputc(',', stdout);
      first_record = 0;
      printf("{\"page\":%i,\"x\":%.6f,\"y\":%.6f,\"h\":%.6f,\"v\":%.6f,\"W\":%.6f,\"H\":%.6f}",
        synctex_node_page(node),
        synctex_node_visible_h(node),
        synctex_node_visible_v(node),
        synctex_node_box_visible_h(node),
        synctex_node_box_visible_v(node) + synctex_node_box_visible_depth(node),
        synctex_node_box_visible_width(node),
        synctex_node_box_visible_height(node) + synctex_node_box_visible_depth(node));
    }
    fputs("]}", stdout);
  }
  printf("],\"firstLine\":%d,\"lastLine\":%d,\"recordCount\":%zu,\"complete\":true}\n",
    first, last, total_records);
  synctex_scanner_free(scanner);
  return ferror(stdout) ? 6 : 0;
}
