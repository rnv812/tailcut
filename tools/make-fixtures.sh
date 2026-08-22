#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname "$0")/../tests/fixtures"
cd "$(dirname "$0")/../tests/fixtures"

# Исходник: 6 секунд, ключевой кадр раз в секунду
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=6 \
       -f lavfi -i sine=frequency=440:duration=6 \
       -c:v libx264 -profile:v main -g 24 -keyint_min 24 -sc_threshold 0 -pix_fmt yuv420p \
       -c:a aac -b:a 64k \
       -shortest source-h264.mp4

# Разложить на init + сегменты по 2 секунды, дорожки раздельно
rm -rf h264 && mkdir h264
ffmpeg -y -i source-h264.mp4 -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 \
       h264/out.mpd

# VP9 в mp4 — второй кодек, чтобы разбор не был заточен под avc1
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=4 \
       -c:v libvpx-vp9 -b:v 300k -g 24 -pix_fmt yuv420p source-vp9.mp4
rm -rf vp9 && mkdir vp9
# -dash_segment_type mp4 обязателен: ffmpeg 4.x по умолчанию кладёт VP9 в webm
ffmpeg -y -i source-vp9.mp4 -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 -dash_segment_type mp4 \
       vp9/out.mpd

ls -la h264 vp9
