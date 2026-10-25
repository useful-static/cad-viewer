#!/usr/bin/env bash
# Stage the one third-party runtime the viewer needs -- occt-import-js
# (OpenCascade compiled to WASM, LGPL-2.1) -- into vendor/occt-import-js/.
# The .wasm is a binary, so it is gitignored and fetched here instead, pinned
# by sha256; a mismatch stages nothing.
#
# Default: OUR build, 0.0.23-progress1 -- occt-import-js 0.0.23 plus
# occt-progress/progress.patch, which reports the import's progress to the page
# (Module.onProgress). Built by occt-progress/build.sh, hosted under
# https://assets.known.name/occt-import-js/. Its output is byte-identical to
# the stock build's.
# --stock: the unmodified 0.0.23 from the npm registry (no progress; the page
# then shows an estimate).
#
# The viewer itself runs without either: .cadmesh files load directly. Only
# STEP / IGES / BREP import (browser worker and stp2mesh.mjs) needs these files.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEST="${HERE}/vendor/occt-import-js"
readonly CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/cad-viewer"

readonly PROGRESS_VERSION="0.0.23-progress1"
readonly PROGRESS_BASE="https://assets.known.name/occt-import-js/${PROGRESS_VERSION}"
# file -> sha256 (occt-progress/build.sh prints these)
readonly -A PROGRESS_SHA=(
	[occt-import-js.js]="561c20cf6d620d0dea029c595b95cf46aeb031b893206bc6c3e48641ecd820a9"
	[occt-import-js.wasm]="aa3086b1fdd21b5519a45db66ea067109f4e92adcb1d412cfce98ab02fd13693"
	[license.occt-import-js.txt]="7ffe1954587c77dfba1cf8eb9b2ea743671fa6e63f9e7a2f258119d42e14eefe"
	[license.occt.txt]="090f8eb6ba63e72887c1f89b009fb1656cfda02d83b6e9805b20468520a5d77f"
	[NOTICE.txt]="4bf2df0642c5b8ef59970a8f6e69005f0eff6bd49ad1671897adbc1069cd0673"
)

readonly STOCK_VERSION="0.0.23"
readonly STOCK_SHA256="eaab9ca7bf02799360d8fc70468dc8bf78eb2073c3fafb1ff982006e558fc1f3"

usage() {
	cat <<USAGE
usage: $(basename "$0") [--stock] [--check]

  Stage occt-import-js into ${DEST}:
    default   ${PROGRESS_VERSION} (with progress reporting) from ${PROGRESS_BASE}/
    --stock   ${STOCK_VERSION} from the npm registry (tarball sha256-pinned)
  --check     only report whether the staged copy is present and current
USAGE
}

staged_ok() {
	[[ -f "${DEST}/occt-import-js.wasm" && -f "${DEST}/occt-import-js.js" && -f "${DEST}/package.json" ]] \
		&& [[ "$(cat "${DEST}/VERSION" 2>/dev/null)" == "$1" ]]
}

finish() { # version
	# occt-import-js.js is CommonJS (stp2mesh.mjs require()s it); the viewer's
	# own package.json says "type": "module", so mark this directory back.
	echo '{ "type": "commonjs" }' > "${DEST}/package.json"
	echo "$1" > "${DEST}/VERSION"
	echo "OK staged occt-import-js $1 in ${DEST}"
}

fetch_progress() {
	local dir="${CACHE}/${PROGRESS_VERSION}" f got want
	mkdir -p "${dir}"
	for f in "${!PROGRESS_SHA[@]}"; do
		want="${PROGRESS_SHA[${f}]}"
		got=""
		[[ -f "${dir}/${f}" ]] && got="$(sha256sum "${dir}/${f}" | cut -d' ' -f1)"
		if [[ "${got}" != "${want}" ]]; then
			curl -fsSL --retry 3 -o "${dir}/${f}.part" "${PROGRESS_BASE}/${f}"
			mv "${dir}/${f}.part" "${dir}/${f}"
			got="$(sha256sum "${dir}/${f}" | cut -d' ' -f1)"
		fi
		if [[ "${got}" != "${want}" ]]; then
			echo "FAIL: sha256 mismatch for ${f}: got ${got}, want ${want}" >&2
			mv -f "${dir}/${f}" "${dir}/${f}.bad"
			return 1
		fi
	done
	mkdir -p "${DEST}"
	for f in "${!PROGRESS_SHA[@]}"; do cp "${dir}/${f}" "${DEST}/"; done
	finish "${PROGRESS_VERSION}"
}

fetch_stock() {
	mkdir -p "${CACHE}"
	local tgz="${CACHE}/occt-import-js-${STOCK_VERSION}.tgz"
	local got=""
	[[ -f "${tgz}" ]] && got="$(sha256sum "${tgz}" | cut -d' ' -f1)"
	if [[ "${got}" != "${STOCK_SHA256}" ]]; then
		# Missing, or a cached copy that does not verify (truncated, tampered):
		# set it aside and fetch fresh, so one bad download is not permanent.
		[[ -f "${tgz}" ]] && mv -f "${tgz}" "${tgz}.bad"
		curl -fsSL --retry 3 -o "${tgz}.part" \
			"https://registry.npmjs.org/occt-import-js/-/occt-import-js-${STOCK_VERSION}.tgz"
		mv "${tgz}.part" "${tgz}"
		got="$(sha256sum "${tgz}" | cut -d' ' -f1)"
	fi
	if [[ "${got}" != "${STOCK_SHA256}" ]]; then
		echo "FAIL: sha256 mismatch for ${tgz}: got ${got}, want ${STOCK_SHA256}" >&2
		mv -f "${tgz}" "${tgz}.bad"
		return 1
	fi
	# Extract into a fresh empty dir; copy out only the runtime files. The EXIT
	# trap (set at the top level) removes it on every path, including a set -e
	# abort in tar or cp, which a RETURN trap does not see.
	EXTRACT_DIR="$(mktemp -d "${CACHE}/extract.XXXXXX")"
	local tmp="${EXTRACT_DIR}"
	tar -xzf "${tgz}" -C "${tmp}" package/dist
	mkdir -p "${DEST}"
	rm -f "${DEST}/NOTICE.txt"
	cp "${tmp}/package/dist/occt-import-js.js" "${tmp}/package/dist/occt-import-js.wasm" \
		"${tmp}/package/dist/license.occt-import-js.txt" "${tmp}/package/dist/license.occt.txt" "${DEST}/"
	finish "${STOCK_VERSION}"
}

main() {
	local want="${PROGRESS_VERSION}" check=0
	while (($#)); do
		case "$1" in
			-h | --help) usage; return 0 ;;
			--stock) want="${STOCK_VERSION}"; shift ;;
			--check) check=1; shift ;;
			*) usage >&2; return 2 ;;
		esac
	done
	if ((check)); then
		if staged_ok "${want}"; then echo "OK occt-import-js ${want} staged in ${DEST}"; return 0; fi
		echo "MISSING occt-import-js ${want} in ${DEST}"
		return 1
	fi
	if staged_ok "${want}"; then
		echo "OK occt-import-js ${want} already staged"
		return 0
	fi
	if [[ "${want}" == "${STOCK_VERSION}" ]]; then fetch_stock; else fetch_progress; fi
}

EXTRACT_DIR=""
trap '[[ -n "${EXTRACT_DIR}" ]] && rm -rf "${EXTRACT_DIR}"' EXIT
main "$@"
