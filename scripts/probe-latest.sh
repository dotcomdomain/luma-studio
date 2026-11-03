#!/bin/sh
# Prints stream details of the newest video in Movies/Luma (uses Termux's ffprobe; testing only).
ssh phone 'F=$(ls -t /sdcard/Movies/Luma/*.mp4 2>/dev/null | head -1); echo "$F"; $PREFIX/bin/ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels,bit_rate,color_space,color_primaries,color_transfer,color_range -of compact "$F"; $PREFIX/bin/ffprobe -v error -show_entries format_tags:stream_tags -of compact "$F" | head -3; head -c 64 "$F" | od -An -c | head -2'
