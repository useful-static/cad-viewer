#!/usr/bin/env bash
# Stage the one third-party runtime the viewer needs -- occt-import-js
# (OpenCascade compiled to WASM, LGPL-2.1) -- into vendor/occt-import-js/.
# The .wasm is a binary, so it is gitignored and fetched here instead, pinned
# by version AND by the tarball's sha256; a mismatch stages nothing.
#
# The viewer itself runs without it: .cadmesh files load directly. Only STEP /
# IGES / BREP import (browser worker and stp2mesh.mjs) needs these files.

set -euo pipefail

readonly VERSION="0.0.23"
readonly SHA256="eaab9ca7bf02799360d8fc70468dc8bf78eb2073c3fafb1ff982006e558fc1f3"
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEST="${HERE}/vendor/occt-import-js"
readonly CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/cad-viewer"

usage() {
	cat <<USAGE
usage: $(basename "$0") [--check]

  Download occt-import-js@${VERSION} from the npm registry, verify sha256,
  and copy dist/{occt-import-js.js,occt-import-js.wasm,license files} into
  ${DEST}.

  --check   only report whether the staged copy is present and current
USAGE
}

staged_ok() {
	[[ -f "${DEST}/occt-import-js.wasm" && -f "${DEST}/occt-import-js.js" && -f "${DEST}/package.json" ]] \
		&& [[ "$(cat "${DEST}/VERSION" 2>/dev/null)" == "${VERSION}" ]]
}

main() {
	case "${1:-}" in
		-h|--help) usage; return 0 ;;
		--check)
			if staged_ok; then echo "OK occt-import-js ${VERSION} staged in ${DEST}"; return 0; fi
			echo "MISSING occt-import-js ${VERSION} in ${DEST}"; return 1 ;;
		"") ;;
		*) usage >&2; return 2 ;;
	esac

	if staged_ok; then
		echo "OK occt-import-js ${VERSION} already staged"
		return 0
	fi

	mkdir -p "${CACHE}"
	local tgz="${CACHE}/occt-import-js-${VERSION}.tgz"
	local got=""
	[[ -f "${tgz}" ]] && got="$(sha256sum "${tgz}" | cut -d' ' -f1)"
	if [[ "${got}" != "${SHA256}" ]]; then
		# Missing, or a cached copy that does not verify (truncated, tampered):
		# set it aside and fetch fresh, so one bad download is not permanent.
		[[ -f "${tgz}" ]] && mv -f "${tgz}" "${tgz}.bad"
		curl -fsSL --retry 3 -o "${tgz}.part" \
			"https://registry.npmjs.org/occt-import-js/-/occt-import-js-${VERSION}.tgz"
		mv "${tgz}.part" "${tgz}"
		got="$(sha256sum "${tgz}" | cut -d' ' -f1)"
	fi
	if [[ "${got}" != "${SHA256}" ]]; then
		echo "FAIL: sha256 mismatch for ${tgz}: got ${got}, want ${SHA256}" >&2
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
	cp "${tmp}/package/dist/occt-import-js.js" "${tmp}/package/dist/occt-import-js.wasm" \
		"${tmp}/package/dist/license.occt-import-js.txt" "${tmp}/package/dist/license.occt.txt" "${DEST}/"
	# occt-import-js.js is CommonJS (stp2mesh.mjs require()s it); the viewer's
	# own package.json says "type": "module", so mark this directory back.
	echo '{ "type": "commonjs" }' > "${DEST}/package.json"
	echo "${VERSION}" > "${DEST}/VERSION"
	echo "OK staged occt-import-js ${VERSION} in ${DEST}"
}

EXTRACT_DIR=""
trap '[[ -n "${EXTRACT_DIR}" ]] && rm -rf "${EXTRACT_DIR}"' EXIT
main "$@"
