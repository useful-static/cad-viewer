#!/usr/bin/env bash
# Convert CAD files with TWO occt-import-js builds and compare the results
# byte for byte. This is the gate for a change to the importer or to
# OpenCascade: a change that is meant only to be faster, or to report
# progress, must leave every converted mesh identical.
#
# For each file: stp2mesh.mjs --raw --no-kind with build A, then with build B,
# then cmp. The meshes are compared with the body statuses left out of the
# header, so a build that reports them can be gated against one that does
# not; when build A reports them, B must report the same (a build that stops
# reporting them is a change).
# Prints one line per file (SAME / DIFF / STATUS / STATUS+DIFF / FAIL-A /
# FAIL-B, the two times), then a summary. Exit 0 when every file is SAME, 1
# otherwise.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STP2MESH="${HERE}/../stp2mesh.mjs"

usage() {
	cat <<EOF
usage: $(basename "$0") --a DIR --b DIR [--jobs N] [--out DIR] FILE...
  --a DIR    first occt-import-js dist dir (occt-import-js.js + .wasm)
  --b DIR    second one
  --jobs N   files converted in parallel (default 8)
  --out DIR  where the outputs and logs go (default ~/.cache/occt-compare)
  FILE...    .stp/.step/.igs/.iges/.brep files
EOF
}

one() { # a b out file
	local a="$1" b="$2" out="$3" f="$4" key ta tb ra rb
	key="$(echo "${f}" | md5sum | cut -c1-12)-$(basename "${f}")"
	ta=$(date +%s.%N)
	# --no-kind: a build that reports each body's b-rep status writes it into
	# the header; the gate compares the meshes
	node "${STP2MESH}" "${f}" -o "${out}/${key}.a.cadmesh" --raw --no-kind --occt "${a}" > "${out}/${key}.a.log" 2>&1 && ra=0 || ra=1
	tb=$(date +%s.%N)
	node "${STP2MESH}" "${f}" -o "${out}/${key}.b.cadmesh" --raw --no-kind --occt "${b}" > "${out}/${key}.b.log" 2>&1 && rb=0 || rb=1
	local te
	te=$(date +%s.%N)
	local verdict sa sb
	# each body's b-rep status, when a build reports it (stp2mesh prints the
	# counts and a digest of the statuses in order): two builds that both
	# report it must agree, or the classification changed
	sa="$(grep -m1 '^bodies by b-rep status' "${out}/${key}.a.log" || true)"
	sb="$(grep -m1 '^bodies by b-rep status' "${out}/${key}.b.log" || true)"
	if ((ra)); then verdict="FAIL-A"
	elif ((rb)); then verdict="FAIL-B"
	else
		local mesh="SAME" status=""
		cmp -s "${out}/${key}.a.cadmesh" "${out}/${key}.b.cadmesh" || mesh="DIFF"
		# A reports statuses: B must report the same ones (losing them is a
		# change too). A reports none (a build before them): meshes only
		[[ -n "${sa}" && "${sa}" != "${sb}" ]] && status="STATUS"
		if [[ -n "${status}" && "${mesh}" == "DIFF" ]]; then verdict="STATUS+DIFF"
		elif [[ -n "${status}" ]]; then verdict="STATUS"
		else verdict="${mesh}"
		fi
	fi
	printf '%-11s a %8.1f s  b %8.1f s  %s\n' "${verdict}" "$(echo "${tb} - ${ta}" | bc)" "$(echo "${te} - ${tb}" | bc)" "${f}"
}
export -f one
export STP2MESH

main() {
	local a="" b="" jobs=8 out="${XDG_CACHE_HOME:-${HOME}/.cache}/occt-compare"
	while (($#)); do
		case "$1" in
			--a) a="$2"; shift 2 ;;
			--b) b="$2"; shift 2 ;;
			--jobs) jobs="$2"; shift 2 ;;
			--out) out="$2"; shift 2 ;;
			-h | --help) usage; return 0 ;;
			--) shift; break ;;
			-*) usage >&2; return 2 ;;
			*) break ;;
		esac
	done
	[[ -n "${a}" && -n "${b}" && $# -gt 0 ]] || { usage >&2; return 2; }
	mkdir -p "${out}"
	local results="${out}/results.txt"
	printf '%s\0' "$@" | xargs -0 -P "${jobs}" -I{} bash -c 'one "$0" "$1" "$2" "$3"' "${a}" "${b}" "${out}" {} | tee "${results}"
	local n same
	n=$(wc -l < "${results}")
	same=$(grep -c '^SAME' "${results}" || true)
	echo "RESULT: ${same}/${n} files byte-identical (A=${a}, B=${b})"
	[[ "${same}" == "${n}" ]]
}

main "$@"
