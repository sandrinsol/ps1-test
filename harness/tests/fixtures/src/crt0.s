# Minimal PS-EXE entry: set up stack/gp, clear .bss, call main.
	.set noreorder
	.section .text.start
	.global _start
_start:
	la	$gp, _gp
	la	$t0, __bss_start
	la	$t1, __bss_end
1:	bge	$t0, $t1, 2f
	nop
	sw	$zero, 0($t0)
	b	1b
	addiu	$t0, $t0, 4
2:	jal	main
	nop
3:	b	3b
	nop
