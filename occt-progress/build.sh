#!/usr/bin/env bash
# Build occt-import-js 0.0.23 (OpenCascade -> WebAssembly) WITH progress
# reporting: progress.patch passes an OpenCascade Message_ProgressRange through
# the STEP/IGES transfer and the meshing, and calls Module.onProgress(phase,
# fraction) from the WASM, so the viewer can show real progress instead of a
# guess. OpenCascade itself is unmodified (its tree is reset to the pinned
# commit on every run). Everything else is the upstream build (emscripten
# 3.1.69, -Oz, the same OCCT commit as the published 0.0.23).
#
# Output: <out>/occt-import-js.js, <out>/occt-import-js.wasm, and their sha256.
# The work tree (sources, emsdk, objects) lives under the cache directory:
# it is large and machine-local, never in git. Re-running reuses what is there.
#
# Licences: occt-import-js and OpenCascade are LGPL-2.1 (OCCT with its
# exception); progress.patch is the modification, published with the viewer.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OIJ_TAG="0.0.23"
readonly OIJ_URL="https://github.com/kovacsv/occt-import-js.git"
readonly OCCT_COMMIT="d2abb6d844231cb8f29be6894440874a4700e4a5" # the submodule commit at 0.0.23
readonly OCCT_URL="https://github.com/Open-Cascade-SAS/OCCT.git"
readonly EMSDK_URL="https://github.com/emscripten-core/emsdk.git"
readonly EMSDK_VER="3.1.69" # tools/setup_emscripten_win.bat at 0.0.23

usage() {
	cat <<EOF
usage: $(basename "$0") [--work DIR] [--out DIR] [--jobs N] [--fetch-only] [--no-patch]
  --work DIR    work tree (default ~/.cache/occt-wasm)
  --out DIR     where the built .js/.wasm go (default <work>/out)
  --jobs N      parallel compile jobs (default nproc)
  --fetch-only  only fetch the sources and the toolchain
  --no-patch    build the unmodified upstream (a control for the patch)
EOF
}

log() { echo "[$(date +%H:%M:%S)] $*"; }

main() {
	local work="${XDG_CACHE_HOME:-${HOME}/.cache}/occt-wasm" out="" jobs fetch_only=0 patch=1
	jobs="$(nproc)"
	while (($#)); do
		case "$1" in
			--work) work="$2"; shift 2 ;;
			--out) out="$2"; shift 2 ;;
			--jobs) jobs="$2"; shift 2 ;;
			--fetch-only) fetch_only=1; shift ;;
			--no-patch) patch=0; shift ;;
			-h | --help) usage; return 0 ;;
			*) usage >&2; return 2 ;;
		esac
	done
	out="${out:-${work}/out}"
	mkdir -p "${work}"
	local src="${work}/occt-import-js"

	if [[ ! -d "${src}/.git" ]]; then
		log "cloning occt-import-js ${OIJ_TAG}"
		git clone -q --depth 1 --branch "${OIJ_TAG}" "${OIJ_URL}" "${src}"
	fi
	if [[ ! -f "${src}/occt/src/Standard/Standard.hxx" ]]; then
		log "fetching OpenCascade ${OCCT_COMMIT}"
		rm -rf "${src}/occt"
		git init -q "${src}/occt"
		git -C "${src}/occt" fetch -q --depth 1 "${OCCT_URL}" "${OCCT_COMMIT}"
		git -C "${src}/occt" -c advice.detachedHead=false checkout -q FETCH_HEAD
	fi
	if [[ ! -x "${work}/emsdk/emsdk" ]]; then
		log "cloning emsdk"
		git clone -q "${EMSDK_URL}" "${work}/emsdk"
	fi
	if [[ ! -f "${work}/emsdk/.emsdk-${EMSDK_VER}-ok" ]]; then
		log "installing emscripten ${EMSDK_VER}"
		(cd "${work}/emsdk" && ./emsdk install "${EMSDK_VER}" && ./emsdk activate "${EMSDK_VER}") > "${work}/emsdk-install.log" 2>&1
		touch "${work}/emsdk/.emsdk-${EMSDK_VER}-ok"
	fi
	((fetch_only)) && { log "fetched"; return 0; }

	# patch (idempotent: start from the pristine sources each time; a file the
	# checkout does not change keeps its timestamp, so a rebuild recompiles
	# only what the patches touch)
	git -C "${src}" checkout -q -- occt-import-js
	rm -f "${src}/occt-import-js/src/progress.hpp"
	git -C "${src}/occt" checkout -q -- .
	if ((patch)); then
		log "applying progress.patch"
		git -C "${src}" apply "${HERE}/progress.patch"
	fi

	# shellcheck disable=SC1091
	source "${work}/emsdk/emsdk_env.sh" > /dev/null 2>&1
	local bdir="${src}/build/wasm-$( ((patch)) && echo progress || echo upstream)"
	log "configuring in ${bdir}"
	(cd "${src}" && emcmake cmake -B "${bdir}" -G "Unix Makefiles" -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release .) > "${work}/cmake.log" 2>&1
	log "building with ${jobs} jobs (log: ${work}/make.log)"
	emmake make -C "${bdir}" -j "${jobs}" > "${work}/make.log" 2>&1
	mkdir -p "${out}"
	cp "${bdir}/Release/occt-import-js.js" "${bdir}/Release/occt-import-js.wasm" "${out}/"
	(cd "${out}" && sha256sum occt-import-js.js occt-import-js.wasm | tee SHA256SUMS)
	log "built into ${out}"
}

main "$@"
