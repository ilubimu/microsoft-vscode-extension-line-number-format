/*
 * sample.c - line-number display fixture
 *
 * A small C file used to verify that the extension works for languages other
 * than assembly. Nothing here is compiled.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define BUFFER_SIZE 256

typedef struct {
    uint32_t id;
    uint32_t flags;
    char name[32];
} record_t;

static uint32_t checksum(const uint8_t *data, size_t length)
{
    uint32_t sum = 0;
    for (size_t i = 0; i < length; i++) {
        sum = (sum << 5) - sum + data[i];
    }
    return sum;
}

static void print_record(const record_t *record)
{
    printf("id=%u flags=0x%08X name=%s\n", record->id, record->flags, record->name);
}

int main(void)
{
    record_t record = { 42, 0xDEADBEEF, "line-number-format" };
    uint8_t buffer[BUFFER_SIZE] = { 0 };

    memcpy(buffer, record.name, strlen(record.name));
    record.flags ^= checksum(buffer, sizeof(record.name));

    print_record(&record);
    return record.flags == 0 ? 1 : 0;
}
