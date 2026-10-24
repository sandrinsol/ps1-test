# A small PSn00bSDK game in C++: text, a player sprite moved by the D-pad or the
# left stick, a GTE-rotated cube and a sound effect on Cross. Builds game.exe
# (+ game.elf with symbols) and a bootable disc, game.bin + game.cue.
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
	LANGUAGES   C CXX ASM
	VERSION     1.0.0
	DESCRIPTION "PS1 game"
)

psn00bsdk_add_executable(game GPREL src/main.cpp src/display.cpp src/player.cpp src/cube.cpp src/sound.cpp)
# Debian/Ubuntu's mipsel-linux-gnu libgcc is built for MIPS32r2 with hard-float
# helpers, which the PS1 can't run. Link libmips1rt (64-bit maths and soft-float
# for MIPS I, installed by .devcontainer/install-psn00bsdk.sh) ahead of it; without
# that library, src/libgcc_mips1.c covers the integer helpers (but not floats).
if(PSN00BSDK_TARGET STREQUAL "mipsel-linux-gnu")
	set(_sdk_libs "${PSN00BSDK_LIBS}")
	if(NOT _sdk_libs)
		set(_sdk_libs "$ENV{PSN00BSDK_LIBS}")
	endif()
	set(MIPS1_RT "${_sdk_libs}/../libmips1rt.a")
	if(EXISTS "${MIPS1_RT}")
		# Ahead of everything (PSn00bSDK puts -lgcc early on the link line);
		# --gc-sections drops what isn't used.
		target_link_options(game PRIVATE "LINKER:--whole-archive,${MIPS1_RT},--no-whole-archive")
	else()
		message(WARNING "libmips1rt.a not found next to PSN00BSDK_LIBS: float/double won't work with this toolchain (run .devcontainer/install-psn00bsdk.sh)")
		target_sources(game PRIVATE src/libgcc_mips1.c)
	endif()
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
