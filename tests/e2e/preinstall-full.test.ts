// The clean-root preinstall of every scanner: about 1 GB of downloads, so it
// runs only with OPENQODEX_PREINSTALL_FULL=1, which the release workflow
// sets before each publish and again after it. The pull request gate loads
// it and skips the full run.
import "../../packages/scanners/test/preinstall.subprocess.test.js";
