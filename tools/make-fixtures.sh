#!/usr/bin/env bash
set -euo pipefail

# Only the segments the tests read end up in tests/fixtures. The source mp4 files and the out.mpd
# manifests are ffmpeg's intermediate product: they live in a temporary directory and are removed
# with it rather than settling into the repository by the hundred kilobytes.
out="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$out"

# Source: six seconds, a key frame once a second.
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=6 \
       -f lavfi -i sine=frequency=440:duration=6 \
       -c:v libx264 -profile:v main -g 24 -keyint_min 24 -sc_threshold 0 -pix_fmt yuv420p \
       -c:a aac -b:a 64k \
       -shortest "$work/source-h264.mp4"

# Split into an init plus two-second segments, the tracks apart.
# The dash muxer puts the segments next to the manifest, so the layout is built in $work and only
# the .m4s files move into the fixtures.
mkdir -p "$work/h264"
ffmpeg -y -i "$work/source-h264.mp4" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 \
       "$work/h264/out.mpd"
rm -rf "$out/h264" && mkdir -p "$out/h264"
cp "$work"/h264/*.m4s "$out/h264/"

# A minute of the same picture and sound, in segments of the length a real site delivers.
#
# The six-second fixture answers what one segment does; this one answers what a watched minute
# does — the length the user reports a defect at, long enough to seek about inside and to fill
# both buffers dozens of times over. Deliberately cheap material: a flat background with one
# moving box, ten frames a second, mono sound at 16 kbit. The container is what is under test,
# not the pixels, and the whole set stays inside two hundred kilobytes.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=60" \
       -f lavfi -i "sine=frequency=440:duration=60" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libx264 -profile:v main -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
       -pix_fmt yuv420p -c:a aac -b:a 16k -ar 22050 -ac 1 \
       -shortest "$work/source-minute.mp4"

mkdir -p "$work/minute"
ffmpeg -y -i "$work/source-minute.mp4" -c copy -f dash -seg_duration 5 \
       -use_template 0 -use_timeline 0 -single_file 0 \
       "$work/minute/out.mpd"
rm -rf "$out/minute" && mkdir -p "$out/minute"
cp "$work"/minute/*.m4s "$out/minute/"

# VP9 in mp4 — a second codec, so that the parsing is not shaped around avc1 alone.
ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24:duration=4 \
       -c:v libvpx-vp9 -b:v 300k -g 24 -pix_fmt yuv420p "$work/source-vp9.mp4"
mkdir -p "$work/vp9"
# -dash_segment_type mp4 is required: ffmpeg 4.x puts VP9 in webm by default.
ffmpeg -y -i "$work/source-vp9.mp4" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 -dash_segment_type mp4 \
       "$work/vp9/out.mpd"
rm -rf "$out/vp9" && mkdir -p "$out/vp9"
cp "$work"/vp9/*.m4s "$out/vp9/"

# WebM — the container the ISO BMFF reader cannot touch. YouTube hands its sound over as
# audio/webm; codecs="opus" and, whenever AV1 is not on offer, its picture as VP9 in WebM too, so a
# stream in Matroska is not an exotic case but the ordinary one.
#
# Both tracks are converted into mp4 on the way in, so both are needed here: the Opus one for the
# dOps and the packet timing, the VP9 one for the vp09 sample entry, the frame durations off the
# cluster timeline and the keyframe flags. The key interval is two seconds, which puts a keyframe
# at the head of every segment and nineteen frames behind it that a seek must not land on.
#
# The material is deliberately cheap — a flat background with one moving box, ten frames a second,
# Opus at 24 kbit — so that the whole set stays under thirty kilobytes. What is under test is the
# element grammar, not the pixels.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=6" \
       -f lavfi -i "sine=frequency=440:duration=6" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libvpx-vp9 -b:v 60k -g 20 -keyint_min 20 -pix_fmt yuv420p \
       -c:a libopus -b:a 24k -ac 2 \
       -shortest "$work/source-webm.webm"

# The same DASH split as the mp4 fixtures: an init segment carrying the Tracks, media segments
# carrying nothing but Clusters. That is the shape MSE is fed, and the shape the parser must read.
mkdir -p "$work/webm"
ffmpeg -y -i "$work/source-webm.webm" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 -dash_segment_type webm \
       "$work/webm/out.mpd"
rm -rf "$out/webm" && mkdir -p "$out/webm"
cp "$work"/webm/*.webm "$out/webm/"

ls -la "$out/h264" "$out/minute" "$out/vp9" "$out/webm"
