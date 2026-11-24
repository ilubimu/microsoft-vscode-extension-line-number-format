; ---------------------------------------------------------------------------
; sample.asm - line-number display fixture
; ---------------------------------------------------------------------------
section .data
    message     db "Hello, hexadecimal line numbers!", 10, 0
    message_len equ $ - message

section .bss
    buffer      resb 128

section .text
    global _start

_start:
    mov rax, 1                  ; sys_write
    mov rdi, 1                  ; stdout
    lea rsi, [rel message]      ; buffer address
    mov rdx, message_len        ; buffer length
    syscall

    mov rax, 60                 ; sys_exit
    xor rdi, rdi                ; status = 0
    syscall

; ---------------------------------------------------------------------------
; A few arithmetic instructions so the file has a realistic line count.
; ---------------------------------------------------------------------------
    mov rcx, 16
    xor rbx, rbx
.loop:
    add rbx, rcx
    shl rcx, 1
    dec rcx
    jnz .loop

    ret
