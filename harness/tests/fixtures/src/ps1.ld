/* Bare-metal PS-EXE layout: everything in KSEG0 RAM from 0x80010000. */
OUTPUT_FORMAT("elf32-tradlittlemips")
ENTRY(_start)
SECTIONS {
  . = 0x80010000;
  .text : { *(.text.start) *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) *(.sdata*) }
  _gp = ALIGN(16) + 0x7ff0;
  . = ALIGN(4);
  __bss_start = .;
  .bss : { *(.sbss*) *(.bss*) *(COMMON) }
  . = ALIGN(4);
  __bss_end = .;
  /DISCARD/ : { *(.MIPS.abiflags) *(.reginfo) *(.comment) *(.pdr) *(.gnu.attributes) }
}
