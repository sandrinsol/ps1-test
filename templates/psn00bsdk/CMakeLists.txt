# A small PSn00bSDK game: text, a player sprite moved by the D-pad or the left
# stick, a GTE-rotated cube and a sound effect on Cross. Builds game.exe (+ game.elf with symbols) and a
# bootable disc, game.bin + game.cue.
cmake_minimum_required(VERSION 3.21)

# PSn00bSDK expects mipsel-none-elf; use mipsel-linux-gnu (Debian/Ubuntu's
# gcc-mipsel-linux-gnu) when that's the one installed.
if(NOT DEFINED PSN00BSDK_TARGET)
	find_program(_mips_none mipsel-none-elf-gcc)
	find_program(_mips_gnu mipsel-linux-gnu-gcc)
	if(NOT _mips_none AND _mips_gnu)
		set(PSN00BSDK_TARGET mipsel-linux-gnu CACHE STRING "Toolchain prefix")
	endif()
endif()

project(
	game
	LANGUAGES   C ASM
	VERSION     1.0.0
	DESCRIPTION "PS1 game"
)

psn00bsdk_add_executable(game GPREL src/main.c src/cube.c)
# Debian/Ubuntu's mipsel-linux-gnu libgcc is built for MIPS32r2, which the
# PS1 can't run: use plain-C versions of its helpers instead.
if(PSN00BSDK_TARGET STREQUAL "mipsel-linux-gnu")
	target_sources(game PRIVATE src/libgcc_mips1.c)
endif()
# The player's texture and the sound effect, converted from assets/player.png
# and assets/blip.wav (see README).
psn00bsdk_target_incbin(game PRIVATE player_tim assets/player.tim)
psn00bsdk_target_incbin(game PRIVATE blip_vag assets/blip.vag)

psn00bsdk_add_cd_image(
	iso      # Target name
	game     # Output file name (= game.bin + game.cue)
	iso.xml  # Path to config file
	DEPENDS game system.cnf
)
