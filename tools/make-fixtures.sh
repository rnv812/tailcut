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

# AV1 in mp4 — what YouTube serves whenever the machine can decode it, and the one picture codec
# that arrives in mp4 without an avc1 sample entry. Nothing above the container reads the codec,
# which is exactly the claim this fixture is here to hold to: the bytes cross into the saved file
# untouched and only the boxes around them are rewritten.
#
# The same cheap material as the WebM set and the same six seconds, so that a page can pair this
# picture with the Opus sound of that set and both tracks cover one stretch of the timeline.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=6" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libaom-av1 -cpu-used 8 -b:v 60k -g 20 -keyint_min 20 -pix_fmt yuv420p \
       "$work/source-av1.mp4"

mkdir -p "$work/av1"
# -dash_segment_type mp4 for the same reason as the VP9 set: left to itself the muxer would pick
# webm for a codec it knows from there.
ffmpeg -y -i "$work/source-av1.mp4" -c copy -f dash -seg_duration 2 \
       -use_template 0 -use_timeline 0 -single_file 0 -dash_segment_type mp4 \
       "$work/av1/out.mpd"
rm -rf "$out/av1" && mkdir -p "$out/av1"
cp "$work"/av1/*.m4s "$out/av1/"

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

# A muxed buffer: one init describing both tracks, and media segments carrying a traf for each.
#
# Every other set here is split the way DASH delivers it — a SourceBuffer per kind, one ISO track
# per init segment. A page is free to hand one buffer both kinds at once
# (video/mp4; codecs="avc1.4d401e,mp4a.40.2"), and then a single moov holds two traks and a single
# moof holds two trafs; the session registry names that case in as many words. Nothing else in the
# fixtures has that shape, and with one trak in the moov the question a reader of an init answers
# never comes up: "the track this sample entry belongs to" and "the first track there is" are the
# same track, and code that confuses them cannot be caught.
#
# The same cheap material as the WebM and AV1 sets, in h264 and AAC so that the two tracks count
# their time differently — 10240 ticks a second for the picture, 22050 for the sound. That
# difference is the point of the fixture: measured off the wrong trak, six seconds of sound comes
# out as thirteen, and the file stays consistent enough that ffprobe reports it without a word.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=6" \
       -f lavfi -i "sine=frequency=440:duration=6" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libx264 -profile:v main -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
       -pix_fmt yuv420p -c:a aac -b:a 16k -ar 22050 -ac 1 \
       -shortest "$work/source-muxed.mp4"

# The mov muxer and not the dash one: dash splits the tracks apart, which is the very thing this
# set is here not to do. -frag_keyframe cuts a fragment at every key frame, so the fragments come
# out two seconds long like the segments of the other sets.
ffmpeg -y -i "$work/source-muxed.mp4" -c copy \
       -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof \
       "$work/muxed.mp4"

rm -rf "$out/muxed" && mkdir -p "$out/muxed"
# Cut into what MSE is fed: ftyp and moov as the init segment, then every moof with the mdat
# behind it as a media segment. The mfra the muxer leaves at the end of the file is an index of
# the whole file and belongs to no segment, so it is dropped with everything else past the last
# mdat.
node -e '
  const fs = require("fs")
  const data = fs.readFileSync(process.argv[1])
  const boxes = []
  for (let at = 0; at + 8 <= data.length; ) {
    const size = data.readUInt32BE(at)
    if (size < 8) break
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), at, size })
    at += size
  }
  const starts = boxes.filter((b) => b.type === "moof").map((b) => b.at)
  const last = boxes.filter((b) => b.type === "mdat").pop()
  fs.writeFileSync(`${process.argv[2]}/init-stream0.m4s`, data.subarray(0, starts[0]))
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? last.at + last.size
    const name = `chunk-stream0-${String(i + 1).padStart(5, "0")}.m4s`
    fs.writeFileSync(`${process.argv[2]}/${name}`, data.subarray(start, end))
  }
' "$work/muxed.mp4" "$out/muxed"

# The same muxed buffer again, with the edit list each track carries of its own.
#
# The set above answers "which trak does this sample entry belong to"; it cannot answer "which
# trak does this edit list belong to", because with empty_moov the muxer writes the moov before
# it has seen a packet and so states no elst at all. delay_moov holds the moov back until the
# first packet of each stream is known, and then ffmpeg writes what every real muxed init has:
# one elst per trak, with a different media_time in each.
#
# The two numbers are the point of the set. The picture hides 2048 ticks of 10240 — the 0.2 s of
# B-frame reordering delay; the sound hides 1024 of 22050 — the 46 ms of AAC encoder priming.
# Neither is a rounding of the other, and neither is zero, so a reader that takes the first elst
# of the moov for every track it is asked about puts the sound 46 ms away from the picture and
# leaves the file otherwise consistent.
ffmpeg -y -i "$work/source-muxed.mp4" -c copy \
       -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+delay_moov \
       "$work/muxed-edits.mp4"

rm -rf "$out/muxed-edits" && mkdir -p "$out/muxed-edits"
node -e '
  const fs = require("fs")
  const data = fs.readFileSync(process.argv[1])
  const boxes = []
  for (let at = 0; at + 8 <= data.length; ) {
    const size = data.readUInt32BE(at)
    if (size < 8) break
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), at, size })
    at += size
  }
  const starts = boxes.filter((b) => b.type === "moof").map((b) => b.at)
  const last = boxes.filter((b) => b.type === "mdat").pop()
  fs.writeFileSync(`${process.argv[2]}/init-stream0.m4s`, data.subarray(0, starts[0]))
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? last.at + last.size
    const name = `chunk-stream0-${String(i + 1).padStart(5, "0")}.m4s`
    fs.writeFileSync(`${process.argv[2]}/${name}`, data.subarray(start, end))
  }
' "$work/muxed-edits.mp4" "$out/muxed-edits"

# A Common Encryption init segment: the header of a protected stream, and the one thing the
# extension has to recognise before it copies anything of such a page.
#
# The same picture as the h264 set, from the same source, so that a page can open one SourceBuffer
# with video/mp4; codecs="avc1.4d401e" and feed it the clear init of that set or this protected one
# — which is what a site does when it switches from a free preview to the licensed material.
# What makes it protected is the shape of the moov: the sample entry is `encv` instead of `avc1`,
# and inside it sits `sinf` with `frma`, `schm` and `tenc`, exactly as measured on the dash.js
# ClearKey sample and on the protected buffers of edition.cnn.com.
#
# Only the header is kept. The fragments ffmpeg 4.4 writes beside it hold encrypted samples but no
# `senc`, so as evidence of encryption they would be a fake; the fragment side of the recognition
# is covered by a `senc` built in the test itself (tests/core/encryption.test.ts).
#
# The key is written here in plain sight on purpose: it protects nothing and it is nobody's. Both
# it and the identifier are made up for this fixture.
ffmpeg -y -i "$work/source-h264.mp4" -map 0:v -c copy \
       -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof \
       -encryption_scheme cenc-aes-ctr \
       -encryption_key 00112233445566778899aabbccddeeff \
       -encryption_kid 11223344556677889900aabbccddeeff \
       "$work/cenc.mp4"

rm -rf "$out/cenc" && mkdir -p "$out/cenc"
# ftyp and moov, and not a byte of the fragments behind them: the head of the file ends where the
# first `moof` begins.
node -e '
  const fs = require("fs")
  const data = fs.readFileSync(process.argv[1])
  let at = 0
  while (at + 8 <= data.length) {
    const size = data.readUInt32BE(at)
    const type = data.toString("latin1", at + 4, at + 8)
    if (type === "moof") break
    at += size
  }
  fs.writeFileSync(process.argv[2], data.subarray(0, at))
' "$work/cenc.mp4" "$out/cenc/init-stream0.m4s"

# The set that holds more than one of everything a reader walks.
#
# Four rounds of mutation testing kept finding one family of defect: a reader handed a container
# with several of something takes the first and calls it the one it was asked about. The `muxed`
# and `muxed-edits` sets closed two of those and left the rest alive, because ffmpeg writes one
# trun per traf, one entry per stsd and zeroes in every trex, and states the sample defaults in the
# tfhd of every fragment — so the walk over runs never turns twice, the "first entry only" contract
# of a sample description is never put to the question, and the fall-through to the movie is never
# taken.
#
# So this set is ffmpeg's material in a container written by hand. What the encoder can state, the
# encoder states: two tracks with a timescale each (30000 for the picture, forced with
# -video_track_timescale so that a frame is 3000 ticks rather than the 1024 an AAC frame happens to
# be at 22050 as well), an edit list each with a media_time that is not a rounding of the other's
# (6000 ticks of B-frame reordering delay against 1024 of encoder priming), a moof carrying a traf
# per track. What no encoder writes, tools/make-multi-fixture.mjs restates around the very same
# coded frames: several truns per traf with their bytes interleaved so that consecutive runs are
# not adjacent, a tfhd that states none of its optional fields beside one that states all of them
# including the sample description index, a trex per track carrying what those fragments no longer
# say, and a second entry in every stsd.
#
# Nothing is invented: the file the segments reassemble into decodes to the same picture and the
# same sound as the one ffmpeg wrote, byte for byte, which tests/core/multi-track.test.ts checks
# before it checks anything else.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=6" \
       -f lavfi -i "sine=frequency=440:duration=6" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libx264 -profile:v main -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
       -pix_fmt yuv420p -c:a aac -b:a 16k -ar 22050 -ac 1 \
       -video_track_timescale 30000 \
       -shortest "$work/source-multi.mp4"

ffmpeg -y -i "$work/source-multi.mp4" -c copy \
       -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+delay_moov \
       "$work/multi.mp4"

node "$(dirname "$0")/make-multi-fixture.mjs" "$work/multi.mp4" "$out/multi"

# The same material as the `muxed-edits` set, written as an ordinary complete file — the shape 18
# of the 21 pages that delivered video in the survey deliver it in, and the shape our reader was
# not written for.
#
# From the very same `$work/source-muxed.mp4` and with the same `-c copy`, which is the whole point
# of the set: the coded frames of `plain/whole.mp4` and of `muxed-edits/*.m4s` are the same bytes,
# so the two files are one recording described twice — once by a moof per fragment, once by the
# six tables of a movie box. Indexing both and comparing the sample lists field for field is what
# tells us which of the two readers is wrong when they disagree
# (tests/core/movie.test.ts).
#
# What ffmpeg puts in the tables here is not the degenerate case: the picture gets an stsc of two
# runs over 59 chunks, the sound one of twenty runs whose chunks hold one, two or three packets
# apiece, an stts of two entries because the last AAC frame is short, a ctts of 57 entries and an
# stss naming three key frames of sixty. A reader that took "one chunk, one sample apiece" for the
# general case comes apart on the sound of this file and on nothing else in the fixtures.
rm -rf "$out/plain" && mkdir -p "$out/plain"

# moov at the tail, which is where a muxer leaves it when nobody asks otherwise: ftyp, free, mdat,
# moov. Locating that movie box costs a second ranged read; see src/core/iso/locate.ts.
ffmpeg -y -i "$work/source-muxed.mp4" -c copy -f mp4 "$out/plain/whole.mp4"

# The same file written for streaming — ftyp, moov, free, mdat — which a site that means its video
# to start before it has finished downloading serves instead. The movie box is then inside the
# first ranged read and costs nothing further.
ffmpeg -y -i "$work/source-muxed.mp4" -c copy -f mp4 -movflags +faststart "$out/plain/faststart.mp4"

# Twenty seconds of the same cheap material, as an ordinary complete file in both layouts.
#
# The pair above is eighteen kilobytes and six seconds long, which is enough to compare two
# readers and not enough to be watched: triage gives a player six seconds of real playing before
# it will call it a player at all, and a clip that ends at the threshold cannot be watched partway
# through. This is the file the browser tests actually play — long enough to watch a piece of,
# small enough to sit in the repository at fifty-four kilobytes a copy.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=20" \
       -f lavfi -i "sine=frequency=440:duration=20" \
       -vf "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -c:v libx264 -profile:v main -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
       -pix_fmt yuv420p -c:a aac -b:a 16k -ar 22050 -ac 1 \
       -shortest "$work/source-watched.mp4"

# ftyp, free, mdat, moov: the movie box behind 46 kilobytes of material, so the probe at the front
# of the file cannot reach it and the walk has to step over the mdat by its stated length.
ffmpeg -y -i "$work/source-watched.mp4" -c copy -f mp4 "$out/plain/watched.mp4"
# ftyp, moov, free, mdat: the movie box inside the first probe, and the whole file found in one
# request.
ffmpeg -y -i "$work/source-watched.mp4" -c copy -f mp4 -movflags +faststart \
       "$out/plain/watched-faststart.mp4"

# One picture and two sound tracks: a file that holds alternates rather than qualities.
#
# The shape measured on w3schools' mov_bbb.mp4, and the reason `alternate` exists as a word of its
# own. A save takes one track of each kind, so something really is left behind and the popup owes
# the user a line about it — but nothing here was recorded twice over, and calling the second
# soundtrack another quality of the first was a sentence about a file of a different shape.
#
# The two are given languages so that what they are is written in the file and not only in this
# comment: a dub beside the original, which is what a second sound track is on the web.
ffmpeg -y -f lavfi -i "color=c=#202040:s=256x144:r=10:d=6" \
       -f lavfi -i "sine=frequency=440:duration=6" \
       -f lavfi -i "sine=frequency=880:duration=6" \
       -filter:v "drawbox=x='mod(t*60\,220)':y='60+40*sin(t)':w=30:h=30:color=orange:t=fill" \
       -map 0:v -map 1:a -map 2:a \
       -c:v libx264 -profile:v main -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
       -pix_fmt yuv420p -c:a aac -b:a 16k -ar 22050 -ac 1 \
       -metadata:s:a:0 language=eng -metadata:s:a:1 language=rus \
       -shortest -f mp4 "$out/plain/two-sound.mp4"

ls -la "$out/h264" "$out/minute" "$out/vp9" "$out/av1" "$out/webm" "$out/muxed" "$out/muxed-edits" "$out/multi" "$out/cenc" "$out/plain"
