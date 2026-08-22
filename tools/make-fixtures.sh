#!/usr/bin/env bash
set -euo pipefail

# В tests/fixtures попадают только сегменты, которые читают тесты. Исходные mp4 и
# манифесты out.mpd — промежуточный продукт ffmpeg: они живут во временном каталоге
# и удаляются вместе с ним, чтобы не оседать в репозитории сотнями килобайт.
out="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$out"

# Исходник: 6 секунд, ключевой кадр раз в секунду
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=6 \
       -f lavfi -i sine=frequency=440:duration=6 \
       -c:v libx264 -profile:v main -g 24 -keyint_min 24 -sc_threshold 0 -pix_fmt yuv420p \
       -c:a aac -b:a 64k \
       -shortest "$work/source-h264.mp4"

# Разложить на init + сегменты по 2 секунды, дорожки раздельно.
# Муксер dash кладёт сегменты рядом с манифестом, поэтому раскладка идёт в $work,
# а в фикстуры переезжают только .m4s.
mkdir -p "$work/h264"
ffmpeg -y -i "$work/source-h264.mp4" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 \
       "$work/h264/out.mpd"
rm -rf "$out/h264" && mkdir -p "$out/h264"
cp "$work"/h264/*.m4s "$out/h264/"

# VP9 в mp4 — второй кодек, чтобы разбор не был заточен под avc1
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=4 \
       -c:v libvpx-vp9 -b:v 300k -g 24 -pix_fmt yuv420p "$work/source-vp9.mp4"
mkdir -p "$work/vp9"
# -dash_segment_type mp4 обязателен: ffmpeg 4.x по умолчанию кладёт VP9 в webm
ffmpeg -y -i "$work/source-vp9.mp4" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 -dash_segment_type mp4 \
       "$work/vp9/out.mpd"
rm -rf "$out/vp9" && mkdir -p "$out/vp9"
cp "$work"/vp9/*.m4s "$out/vp9/"

ls -la "$out/h264" "$out/vp9"
