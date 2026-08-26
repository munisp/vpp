# Critical Advisory Details and Remediation

**Scope:** Root and mobile `pnpm audit --prod` results captured on 2026-08-26. The full, unabridged dependency-path evidence is preserved in [critical-dependency-advisories.md](critical-dependency-advisories.md). This companion document summarizes the smallest safe remediation applied for each advisory.

> **Result:** The root and mobile production dependency graphs now report **zero critical advisories**. The remaining high and moderate advisories are not silently accepted; they remain tracked in `assurance/remediation-ledger.yaml` for a separate, reviewable remediation program.

| Surface | Advisory | Module and affected version | Exact dependency path class | Fixed version | Applied remediation | Final result |
|---|---|---|---|---|---|---|
| Root | [GHSA-f8cm-6447-x5h2][1] | `jspdf@3.0.3`, affected through `<=3.0.4` | Direct dependency: `. > jspdf@3.0.3` | `4.2.1` | Upgraded the root `jspdf` manifest entry to `^4.2.1`; source audit found no application import of jsPDF. | Cleared. |
| Root | [GHSA-wfv2-pwc8-crg5][2] | `jspdf@3.0.3`, affected through `<=4.2.0` | Direct dependency: `. > jspdf@3.0.3` | `4.2.1` | Resolved by the same direct jsPDF upgrade. | Cleared. |
| Root | [GHSA-m7jm-9gc2-mpf2][3] | `fast-xml-parser@5.2.5`, affected through `>=5.0.0 <5.3.5` | AWS SDK graph, led by `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`, and `@types/nodemailer` through `@aws-sdk/xml-builder`. | `5.3.5` | Added a root pnpm override for `fast-xml-parser: 5.3.5`. | Cleared. |
| Root | [GHSA-xq3m-2v4x-88gg][4] | `protobufjs@7.5.4`, affected through `<7.5.5` | Temporal and Firebase graphs, including `@temporalio/{activity,client,worker,workflow}` and Firebase gRPC/proto dependencies. | `7.5.5` | Added a root pnpm override for `protobufjs: 7.5.5`. | Cleared. |
| Root | [GHSA-xv26-6w52-cph6][5] | `websocket-driver@0.7.4`, affected through `<0.7.5` | Firebase Realtime Database graph through `faye-websocket@0.11.4`. | `0.7.5` | Added a root pnpm override for `websocket-driver: 0.7.5`. | Cleared. |
| Mobile | [GHSA-m7jm-9gc2-mpf2][3] | `fast-xml-parser@4.5.3`, affected through `>=4.1.3 <4.5.4` | Expo/React Native CLI dependency graph, led by `react-native@0.73.6` and Expo modules. | `4.5.4` | Added the mobile pnpm override `fast-xml-parser: 4.5.4`. | Cleared. |
| Mobile | [GHSA-w7jw-789q-3m8p][6] | `shell-quote@1.8.3`, affected through `>=1.1.0 <=1.8.3` | React Native community CLI tooling through `@react-native-community/cli-tools`. | `1.8.4` | Added the mobile pnpm override `shell-quote: 1.8.4`. | Cleared. |
| Mobile | [GHSA-23hp-3jrh-7fpw][7] | `tar@7.5.18`, affected through `<=7.5.18` | Expo package/tooling graph, led by the SDK 50 Expo module set. | `7.5.19` | Added the mobile pnpm override `tar: 7.5.19`. | Cleared. |

## Verification

The remediation required a pnpm runtime update from `10.4.1` to `10.15.1`: the former did not apply the version-controlled `pnpm-workspace.yaml` overrides; the latter applied the documented workspace override policy and regenerated both lockfiles. The validated commands were:

```bash
# Root
pnpm install --frozen-lockfile
pnpm audit --prod --json
pnpm check
pnpm test
pnpm build

# Mobile
cd mobile
pnpm install --frozen-lockfile
pnpm audit --prod --json
pnpm dlx expo-doctor
pnpm exec expo export -p android
```

All installation, build, type-check, test, Expo diagnostic, and Android-export gates passed. Final audit totals were **root: 0 critical, 46 high, 66 moderate, 14 low** and **mobile: 0 critical, 52 high, 18 moderate, 2 low**.

## References

[1]: https://github.com/advisories/GHSA-f8cm-6447-x5h2 "GitHub Advisory: jsPDF local file inclusion/path traversal"
[2]: https://github.com/advisories/GHSA-wfv2-pwc8-crg5 "GitHub Advisory: jsPDF new-window HTML injection"
[3]: https://github.com/advisories/GHSA-m7jm-9gc2-mpf2 "GitHub Advisory: fast-xml-parser entity encoding bypass"
[4]: https://github.com/advisories/GHSA-xq3m-2v4x-88gg "GitHub Advisory: protobufjs arbitrary code execution"
[5]: https://github.com/advisories/GHSA-xv26-6w52-cph6 "GitHub Advisory: websocket-driver message corruption"
[6]: https://github.com/advisories/GHSA-w7jw-789q-3m8p "GitHub Advisory: shell-quote command injection"
[7]: https://github.com/advisories/GHSA-23hp-3jrh-7fpw "GitHub Advisory: node-tar decompression/parse denial of service"
