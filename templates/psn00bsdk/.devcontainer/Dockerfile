# PS1 homebrew: Debian/Ubuntu's MIPS cross compiler + PSn00bSDK (built from
# source, see install-psn00bsdk.sh).
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo \
 && rm -rf /var/lib/apt/lists/*
COPY install-psn00bsdk.sh build-mips1-rt.sh elf2x-ptload.patch /tmp/sdk/
RUN /tmp/sdk/install-psn00bsdk.sh /opt/psn00bsdk && rm -rf /tmp/sdk /var/lib/apt/lists/*

ENV PSN00BSDK_LIBS=/opt/psn00bsdk/lib/libpsn00b
ENV PATH=/opt/psn00bsdk/bin:$PATH
