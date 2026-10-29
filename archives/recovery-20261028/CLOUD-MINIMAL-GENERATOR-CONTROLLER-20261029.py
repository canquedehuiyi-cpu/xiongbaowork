#!/usr/bin/python3
"""Administrative controller only. Project stages run after irreversible runner UID drop."""
import base64, gzip, hashlib, json, math, os, pwd, shutil, stat, subprocess, sys, tarfile, time, urllib.parse, urllib.request
from pathlib import Path, PurePosixPath
PLAN = json.loads("{\"schema\":\"xiongbaowork-minimal-generator-author-plan-v1\",\"author\":\"cloud-agent:/root/a7_prepare\",\"base\":\"f97260fa06af41ea8a5e7d94420de53eee99cb49\",\"prepare_branch\":\"codex/cloud-minimal-generator-prep-20261029-a11\",\"only_run_branch\":\"codex/cloud-minimal-generator-run-20261029-a11\",\"source\":{\"manifest_path\":\"archives/recovery-20261028/CURRENT-SOURCE-EXPECTED-MANIFEST.json\",\"manifest_bytes\":456310,\"manifest_sha256\":\"7028278e9ff0da8e2f545964c55360c2535cba619102db4dcd0b020e23f0c632\",\"files\":2065,\"bytes\":50175181},\"overlay\":{\"ref\":\"95ebc15ba4c6f53ead7a1a659565a1cdfbecf549\",\"path\":\"openbot/server/src/db/schema/approvals.ts\",\"blob\":\"178dd18f90315ed952c2b7e8bac6246453ae49dc\",\"bytes\":13100,\"sha256\":\"f86495a58bd580d633b0a3a3f0e61138ecd91cec133aef4e9e3851e4d2d47c12\",\"formal_adoption\":false},\"schema_paths\":[\"./src/db/schema/admin.ts\",\"./src/db/schema/approval-direct-execution-domains.ts\",\"./src/db/schema/approval-exact-input-objects.ts\",\"./src/db/schema/approvals.ts\",\"./src/db/schema/automation-foundations.ts\",\"./src/db/schema/automation-run-records.ts\",\"./src/db/schema/components.ts\",\"./src/db/schema/computer.ts\",\"./src/db/schema/core.ts\",\"./src/db/schema/coworker.ts\",\"./src/db/schema/delivery.ts\",\"./src/db/schema/demonstrations.ts\",\"./src/db/schema/device-binding-leases.ts\",\"./src/db/schema/devices.ts\",\"./src/db/schema/flow-customization-foundations.ts\",\"./src/db/schema/flow-customization-turns.ts\",\"./src/db/schema/flow-official-bindings.ts\",\"./src/db/schema/flow-run-coordination.ts\",\"./src/db/schema/flow-sharing-foundations.ts\",\"./src/db/schema/flow-source-foundations.ts\",\"./src/db/schema/flow-source-original-records.ts\",\"./src/db/schema/flow-source-run-records.ts\",\"./src/db/schema/flow-source-runtime-records.ts\",\"./src/db/schema/group-pipeline-start-receipts.ts\",\"./src/db/schema/group.ts\",\"./src/db/schema/import-proactive-token-foundations.ts\",\"./src/db/schema/knowledge-foundations.ts\",\"./src/db/schema/knowledge-write-foundations.ts\",\"./src/db/schema/lifecycle.ts\",\"./src/db/schema/memory.ts\",\"./src/db/schema/model.ts\",\"./src/db/schema/outbox-knowledge-heads.ts\",\"./src/db/schema/passwords.ts\",\"./src/db/schema/pipeline.ts\",\"./src/db/schema/plans.ts\",\"./src/db/schema/plugin-assembly-foundations.ts\",\"./src/db/schema/plugins.ts\",\"./src/db/schema/proactive.ts\",\"./src/db/schema/resource-project-foundations.ts\",\"./src/db/schema/responsibilities.ts\",\"./src/db/schema/roles.ts\",\"./src/db/schema/scim.ts\",\"./src/db/schema/security-policy-fences.ts\",\"./src/db/schema/tasks.ts\",\"./src/db/schema/team-bots.ts\",\"./src/db/schema/threads.ts\",\"./src/db/schema/voice.ts\",\"./src/db/schema/waker-groups.ts\",\"./src/db/schema/wakerflows.ts\",\"./src/db/schema/work.ts\"],\"schema_modules\":[{\"path\":\"openbot/server/src/db/schema/admin.ts\",\"bytes\":5688,\"blob\":\"33a0585b979bd07d939be4c2bc71a5ed20939591\"},{\"path\":\"openbot/server/src/db/schema/approval-direct-execution-domains.ts\",\"bytes\":3336,\"blob\":\"f4b7167267c32030a4043e0d8fe6815656983f3b\"},{\"path\":\"openbot/server/src/db/schema/approval-exact-input-objects.ts\",\"bytes\":12894,\"blob\":\"94d055b9cebe809b1e5e2ba4a2d84238ac0ee878\"},{\"path\":\"openbot/server/src/db/schema/approvals.ts\",\"bytes\":13100,\"blob\":\"178dd18f90315ed952c2b7e8bac6246453ae49dc\"},{\"path\":\"openbot/server/src/db/schema/automation-foundations.ts\",\"bytes\":1735,\"blob\":\"30aaa057c907399272562ecc5d2a24db2b0074bf\"},{\"path\":\"openbot/server/src/db/schema/automation-run-records.ts\",\"bytes\":3043,\"blob\":\"befc051b34c25e703f63e15b109d6fce2995a295\"},{\"path\":\"openbot/server/src/db/schema/components.ts\",\"bytes\":4598,\"blob\":\"667bb125dcc2c2ccb7ad5fc2cddb4cb0a5619b82\"},{\"path\":\"openbot/server/src/db/schema/computer.ts\",\"bytes\":6668,\"blob\":\"595c8df8c218668f343b86ef754d1335e2ac853e\"},{\"path\":\"openbot/server/src/db/schema/core.ts\",\"bytes\":26447,\"blob\":\"38b94cc1b66876764af887a7c268c30d500f4c26\"},{\"path\":\"openbot/server/src/db/schema/coworker.ts\",\"bytes\":8323,\"blob\":\"ac64d935fc7d3add63226152360ae2aae74d8ca2\"},{\"path\":\"openbot/server/src/db/schema/delivery.ts\",\"bytes\":4337,\"blob\":\"a5e6e0dfb69d7b4bd9b345bf5da41ca38fb3c1bf\"},{\"path\":\"openbot/server/src/db/schema/demonstrations.ts\",\"bytes\":1442,\"blob\":\"6d38c3af143cd7493bdae1ebab7518cac97558d2\"},{\"path\":\"openbot/server/src/db/schema/device-binding-leases.ts\",\"bytes\":4516,\"blob\":\"b5ed0f66f5bd95f8a3969c895da7847248190380\"},{\"path\":\"openbot/server/src/db/schema/devices.ts\",\"bytes\":3584,\"blob\":\"f3b333abeea3edf006d9fe19f3f6fcd0f9147440\"},{\"path\":\"openbot/server/src/db/schema/flow-customization-foundations.ts\",\"bytes\":4446,\"blob\":\"400dc055c5513d59cebc0e7df2391ebb990eb06e\"},{\"path\":\"openbot/server/src/db/schema/flow-customization-turns.ts\",\"bytes\":2785,\"blob\":\"2cb8ce28c0f69fbb3d6462b698761d6d10659c16\"},{\"path\":\"openbot/server/src/db/schema/flow-official-bindings.ts\",\"bytes\":3548,\"blob\":\"d43cb340cf59275ef0d7654d0ff6f161a7d102c3\"},{\"path\":\"openbot/server/src/db/schema/flow-run-coordination.ts\",\"bytes\":8003,\"blob\":\"20eb3ade1788bdee9aab7f0086604846094a8d1f\"},{\"path\":\"openbot/server/src/db/schema/flow-sharing-foundations.ts\",\"bytes\":4682,\"blob\":\"eaa4a802dab9495cde061f69268e83a485962a85\"},{\"path\":\"openbot/server/src/db/schema/flow-source-foundations.ts\",\"bytes\":8436,\"blob\":\"6a1f57e5ab7ef5098394ef901bbb43f7ac70fa85\"},{\"path\":\"openbot/server/src/db/schema/flow-source-original-records.ts\",\"bytes\":12222,\"blob\":\"f5bb0137285216ef8b75a2b78ce4e196f8cdeb65\"},{\"path\":\"openbot/server/src/db/schema/flow-source-run-records.ts\",\"bytes\":13400,\"blob\":\"2ded0ffb62d4282fed03518a5ebc046044e8bb1d\"},{\"path\":\"openbot/server/src/db/schema/flow-source-runtime-records.ts\",\"bytes\":8919,\"blob\":\"d3a8ebc4b807ec54d4210177d649cecc009d025b\"},{\"path\":\"openbot/server/src/db/schema/group-pipeline-start-receipts.ts\",\"bytes\":2392,\"blob\":\"34983f1233a976e012361d4b7a39b13b92d83a19\"},{\"path\":\"openbot/server/src/db/schema/group.ts\",\"bytes\":1996,\"blob\":\"a1039777623174604be91312f72fdf8702dca8df\"},{\"path\":\"openbot/server/src/db/schema/import-proactive-token-foundations.ts\",\"bytes\":12135,\"blob\":\"11b84fb058d8bef880d3db508c105c7584285f03\"},{\"path\":\"openbot/server/src/db/schema/knowledge-foundations.ts\",\"bytes\":11998,\"blob\":\"cfd27190f54d100d85a75b321d5dd63b44133644\"},{\"path\":\"openbot/server/src/db/schema/knowledge-write-foundations.ts\",\"bytes\":12825,\"blob\":\"36ffe8885a0ecbf4a3c757035af62929c1f07560\"},{\"path\":\"openbot/server/src/db/schema/lifecycle.ts\",\"bytes\":2605,\"blob\":\"f65b11453f14b1de3a9c08d86a0ac5e7226eaafa\"},{\"path\":\"openbot/server/src/db/schema/memory.ts\",\"bytes\":3857,\"blob\":\"9ef5ad6f349797a17b62a7d6d79b7a9deacc821e\"},{\"path\":\"openbot/server/src/db/schema/model.ts\",\"bytes\":2024,\"blob\":\"6a168a9be775e456a443d5893d1df1789666962c\"},{\"path\":\"openbot/server/src/db/schema/outbox-knowledge-heads.ts\",\"bytes\":5866,\"blob\":\"7ba19932c19644f36a81bf68f3c335cc232ac166\"},{\"path\":\"openbot/server/src/db/schema/passwords.ts\",\"bytes\":3709,\"blob\":\"fd9b880d342bdc23465d006b67c8b8041ba74226\"},{\"path\":\"openbot/server/src/db/schema/pipeline.ts\",\"bytes\":7462,\"blob\":\"66d0d6f417a78a5b384ac311c459620dd74982b3\"},{\"path\":\"openbot/server/src/db/schema/plans.ts\",\"bytes\":1691,\"blob\":\"2f72854f920231c81b27bf4bc2c5640214be368d\"},{\"path\":\"openbot/server/src/db/schema/plugin-assembly-foundations.ts\",\"bytes\":5290,\"blob\":\"dbce0d05cdeb341ea01465b3dbe325cfbb9edc3d\"},{\"path\":\"openbot/server/src/db/schema/plugins.ts\",\"bytes\":39993,\"blob\":\"5e27d88839b386af9e3ca871c9ecc23bfa6fe912\"},{\"path\":\"openbot/server/src/db/schema/proactive.ts\",\"bytes\":3765,\"blob\":\"76c9b976275224514e79eb14975a5088b297e7ee\"},{\"path\":\"openbot/server/src/db/schema/resource-project-foundations.ts\",\"bytes\":7589,\"blob\":\"f2072820bd8938a4211c939b24dcc4927dffa063\"},{\"path\":\"openbot/server/src/db/schema/responsibilities.ts\",\"bytes\":6378,\"blob\":\"59233d88d5247d75ab0c25aa3cb8368d4a815988\"},{\"path\":\"openbot/server/src/db/schema/roles.ts\",\"bytes\":5115,\"blob\":\"e3db171720a01d26941c25a690e011b141681aee\"},{\"path\":\"openbot/server/src/db/schema/scim.ts\",\"bytes\":7405,\"blob\":\"5db9efdab299e9c51f0ca024b178eb71a1c5d5b5\"},{\"path\":\"openbot/server/src/db/schema/security-policy-fences.ts\",\"bytes\":6038,\"blob\":\"22a1a3f0acc07c5b947866e0fb38cd6add23cacd\"},{\"path\":\"openbot/server/src/db/schema/tasks.ts\",\"bytes\":3589,\"blob\":\"d54c14ff4630ad93c9714dbcef8d19beaefdd323\"},{\"path\":\"openbot/server/src/db/schema/team-bots.ts\",\"bytes\":4098,\"blob\":\"f77e7df444f8b424c69088f61c1ef92b9a0d2a83\"},{\"path\":\"openbot/server/src/db/schema/threads.ts\",\"bytes\":2571,\"blob\":\"4c613d8a5bc400cbde5d8789c1848d727b07c408\"},{\"path\":\"openbot/server/src/db/schema/voice.ts\",\"bytes\":1686,\"blob\":\"6800d6ad403772f8accf378a7ec3a02df63bda71\"},{\"path\":\"openbot/server/src/db/schema/waker-groups.ts\",\"bytes\":1983,\"blob\":\"4ab797c85d80ed8f87e685bfa8c8bbafd5ceac88\"},{\"path\":\"openbot/server/src/db/schema/wakerflows.ts\",\"bytes\":2706,\"blob\":\"2b2d4efd53f6979cc17916d9eb0c0650df4f828c\"},{\"path\":\"openbot/server/src/db/schema/work.ts\",\"bytes\":4789,\"blob\":\"e1cf394067f0e1994925e078a8aae8079f27dee1\"}],\"nodes\":[{\"key\":\"@drizzle-team/brocli\",\"pinned\":\"@drizzle-team/brocli@0.10.2\",\"url\":\"https://registry.npmmirror.com/@drizzle-team/brocli/-/brocli-0.10.2.tgz\",\"metadata\":{},\"integrity\":\"sha512-z33Il7l5dKjUgGULTqBsQBQwckHh5AbIuxhdsIxDDiZAzBOrZO6q9ogcWC65kU382AfynTfgNumVcNIjuIua6w==\",\"placement\":\"node_modules/@drizzle-team/brocli\"},{\"key\":\"@esbuild-kit/core-utils\",\"pinned\":\"@esbuild-kit/core-utils@3.3.2\",\"url\":\"https://registry.npmmirror.com/@esbuild-kit/core-utils/-/core-utils-3.3.2.tgz\",\"metadata\":{\"dependencies\":{\"esbuild\":\"~0.18.20\",\"source-map-support\":\"^0.5.21\"}},\"integrity\":\"sha512-sPRAnw9CdSsRmEtnsl2WXWdyquogVpB3yZ3dgwJfe8zrOzTsV7cJvmwrKVa+0ma5BoiGJ+BoqkMvawbayKUsqQ==\",\"placement\":\"node_modules/@esbuild-kit/core-utils\"},{\"key\":\"@esbuild-kit/core-utils/esbuild\",\"pinned\":\"esbuild@0.18.20\",\"url\":\"https://registry.npmmirror.com/esbuild/-/esbuild-0.18.20.tgz\",\"metadata\":{\"optionalDependencies\":{\"@esbuild/android-arm\":\"0.18.20\",\"@esbuild/android-arm64\":\"0.18.20\",\"@esbuild/android-x64\":\"0.18.20\",\"@esbuild/darwin-arm64\":\"0.18.20\",\"@esbuild/darwin-x64\":\"0.18.20\",\"@esbuild/freebsd-arm64\":\"0.18.20\",\"@esbuild/freebsd-x64\":\"0.18.20\",\"@esbuild/linux-arm\":\"0.18.20\",\"@esbuild/linux-arm64\":\"0.18.20\",\"@esbuild/linux-ia32\":\"0.18.20\",\"@esbuild/linux-loong64\":\"0.18.20\",\"@esbuild/linux-mips64el\":\"0.18.20\",\"@esbuild/linux-ppc64\":\"0.18.20\",\"@esbuild/linux-riscv64\":\"0.18.20\",\"@esbuild/linux-s390x\":\"0.18.20\",\"@esbuild/linux-x64\":\"0.18.20\",\"@esbuild/netbsd-x64\":\"0.18.20\",\"@esbuild/openbsd-x64\":\"0.18.20\",\"@esbuild/sunos-x64\":\"0.18.20\",\"@esbuild/win32-arm64\":\"0.18.20\",\"@esbuild/win32-ia32\":\"0.18.20\",\"@esbuild/win32-x64\":\"0.18.20\"},\"bin\":{\"esbuild\":\"bin/esbuild\"}},\"integrity\":\"sha512-ceqxoedUrcayh7Y7ZX6NdbbDzGROiyVBgC4PriJThBKSVPWnnFHZAkfI1lJT8QFkOwH4qOS2SJkS4wvpGl8BpA==\",\"placement\":\"node_modules/@esbuild-kit/core-utils/node_modules/esbuild\"},{\"key\":\"@esbuild-kit/core-utils/esbuild/@esbuild/linux-x64\",\"pinned\":\"@esbuild/linux-x64@0.18.20\",\"url\":\"https://registry.npmmirror.com/@esbuild/linux-x64/-/linux-x64-0.18.20.tgz\",\"metadata\":{\"os\":\"linux\",\"cpu\":\"x64\"},\"integrity\":\"sha512-UYqiqemphJcNsFEskc73jQ7B9jgwjWrSayxawS6UVFZGWrAAtkzjxSqnoclCXxWtfwLdzU+vTpcNYhpn43uP1w==\",\"placement\":\"node_modules/@esbuild-kit/core-utils/node_modules/esbuild/node_modules/@esbuild/linux-x64\"},{\"key\":\"@esbuild-kit/esm-loader\",\"pinned\":\"@esbuild-kit/esm-loader@2.6.5\",\"url\":\"https://registry.npmmirror.com/@esbuild-kit/esm-loader/-/esm-loader-2.6.5.tgz\",\"metadata\":{\"dependencies\":{\"@esbuild-kit/core-utils\":\"^3.3.2\",\"get-tsconfig\":\"^4.7.0\"}},\"integrity\":\"sha512-FxEMIkJKnodyA1OaCUoEvbYRkoZlLZ4d/eXFu9Fh8CbBBgP5EmZxrfTRyN0qpXZ4vOvqnE5YdRdcrmUUXuU+dA==\",\"placement\":\"node_modules/@esbuild-kit/esm-loader\"},{\"key\":\"@esbuild/linux-x64\",\"pinned\":\"@esbuild/linux-x64@0.28.2\",\"url\":\"https://registry.npmmirror.com/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz\",\"metadata\":{\"os\":\"linux\",\"cpu\":\"x64\"},\"integrity\":\"sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==\",\"placement\":\"node_modules/@esbuild/linux-x64\"},{\"key\":\"buffer-from\",\"pinned\":\"buffer-from@1.1.2\",\"url\":\"https://registry.npmmirror.com/buffer-from/-/buffer-from-1.1.2.tgz\",\"metadata\":{},\"integrity\":\"sha512-E+XQCRwSbaaiChtv6k6Dwgc+bx+Bs6vuKJHHl5kox/BaKbhiXzqQOwK4cO22yElGp2OCmjwVhT3HmxgyPGnJfQ==\",\"placement\":\"node_modules/buffer-from\"},{\"key\":\"drizzle-kit\",\"pinned\":\"drizzle-kit@0.31.10\",\"url\":\"https://registry.npmmirror.com/drizzle-kit/-/drizzle-kit-0.31.10.tgz\",\"metadata\":{\"dependencies\":{\"@drizzle-team/brocli\":\"^0.10.2\",\"@esbuild-kit/esm-loader\":\"^2.5.5\",\"esbuild\":\"^0.25.4\",\"tsx\":\"^4.21.0\"},\"bin\":{\"drizzle-kit\":\"bin.cjs\"}},\"integrity\":\"sha512-7OZcmQUrdGI+DUNNsKBn1aW8qSoKuTH7d0mYgSP8bAzdFzKoovxEFnoGQp2dVs82EOJeYycqRtciopszwUf8bw==\",\"placement\":\"node_modules/drizzle-kit\"},{\"key\":\"drizzle-kit/esbuild\",\"pinned\":\"esbuild@0.25.12\",\"url\":\"https://registry.npmmirror.com/esbuild/-/esbuild-0.25.12.tgz\",\"metadata\":{\"optionalDependencies\":{\"@esbuild/aix-ppc64\":\"0.25.12\",\"@esbuild/android-arm\":\"0.25.12\",\"@esbuild/android-arm64\":\"0.25.12\",\"@esbuild/android-x64\":\"0.25.12\",\"@esbuild/darwin-arm64\":\"0.25.12\",\"@esbuild/darwin-x64\":\"0.25.12\",\"@esbuild/freebsd-arm64\":\"0.25.12\",\"@esbuild/freebsd-x64\":\"0.25.12\",\"@esbuild/linux-arm\":\"0.25.12\",\"@esbuild/linux-arm64\":\"0.25.12\",\"@esbuild/linux-ia32\":\"0.25.12\",\"@esbuild/linux-loong64\":\"0.25.12\",\"@esbuild/linux-mips64el\":\"0.25.12\",\"@esbuild/linux-ppc64\":\"0.25.12\",\"@esbuild/linux-riscv64\":\"0.25.12\",\"@esbuild/linux-s390x\":\"0.25.12\",\"@esbuild/linux-x64\":\"0.25.12\",\"@esbuild/netbsd-arm64\":\"0.25.12\",\"@esbuild/netbsd-x64\":\"0.25.12\",\"@esbuild/openbsd-arm64\":\"0.25.12\",\"@esbuild/openbsd-x64\":\"0.25.12\",\"@esbuild/openharmony-arm64\":\"0.25.12\",\"@esbuild/sunos-x64\":\"0.25.12\",\"@esbuild/win32-arm64\":\"0.25.12\",\"@esbuild/win32-ia32\":\"0.25.12\",\"@esbuild/win32-x64\":\"0.25.12\"},\"bin\":{\"esbuild\":\"bin/esbuild\"}},\"integrity\":\"sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==\",\"placement\":\"node_modules/drizzle-kit/node_modules/esbuild\"},{\"key\":\"drizzle-kit/esbuild/@esbuild/linux-x64\",\"pinned\":\"@esbuild/linux-x64@0.25.12\",\"url\":\"https://registry.npmmirror.com/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz\",\"metadata\":{\"os\":\"linux\",\"cpu\":\"x64\"},\"integrity\":\"sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==\",\"placement\":\"node_modules/drizzle-kit/node_modules/esbuild/node_modules/@esbuild/linux-x64\"},{\"key\":\"drizzle-orm\",\"pinned\":\"drizzle-orm@0.45.2\",\"url\":\"https://registry.npmmirror.com/drizzle-orm/-/drizzle-orm-0.45.2.tgz\",\"metadata\":{\"peerDependencies\":{\"@aws-sdk/client-rds-data\":\">=3\",\"@cloudflare/workers-types\":\">=4\",\"@electric-sql/pglite\":\">=0.2.0\",\"@libsql/client\":\">=0.10.0\",\"@libsql/client-wasm\":\">=0.10.0\",\"@neondatabase/serverless\":\">=0.10.0\",\"@op-engineering/op-sqlite\":\">=2\",\"@opentelemetry/api\":\"^1.4.1\",\"@planetscale/database\":\">=1.13\",\"@prisma/client\":\"*\",\"@tidbcloud/serverless\":\"*\",\"@types/better-sqlite3\":\"*\",\"@types/pg\":\"*\",\"@types/sql.js\":\"*\",\"@upstash/redis\":\">=1.34.7\",\"@vercel/postgres\":\">=0.8.0\",\"@xata.io/client\":\"*\",\"better-sqlite3\":\">=7\",\"bun-types\":\"*\",\"expo-sqlite\":\">=14.0.0\",\"gel\":\">=2\",\"knex\":\"*\",\"kysely\":\"*\",\"mysql2\":\">=2\",\"pg\":\">=8\",\"postgres\":\">=3\",\"prisma\":\"*\",\"sql.js\":\">=1\",\"sqlite3\":\">=5\"},\"optionalPeers\":[\"@aws-sdk/client-rds-data\",\"@cloudflare/workers-types\",\"@electric-sql/pglite\",\"@libsql/client\",\"@libsql/client-wasm\",\"@neondatabase/serverless\",\"@op-engineering/op-sqlite\",\"@opentelemetry/api\",\"@planetscale/database\",\"@prisma/client\",\"@tidbcloud/serverless\",\"@types/better-sqlite3\",\"@types/pg\",\"@types/sql.js\",\"@upstash/redis\",\"@vercel/postgres\",\"@xata.io/client\",\"better-sqlite3\",\"bun-types\",\"expo-sqlite\",\"gel\",\"knex\",\"kysely\",\"mysql2\",\"pg\",\"postgres\",\"prisma\",\"sql.js\",\"sqlite3\"]},\"integrity\":\"sha512-kY0BSaTNYWnoDMVoyY8uxmyHjpJW1geOmBMdSSicKo9CIIWkSxMIj2rkeSR51b8KAPB7m+qysjuHme5nKP+E5Q==\",\"placement\":\"node_modules/drizzle-orm\"},{\"key\":\"esbuild\",\"pinned\":\"esbuild@0.28.2\",\"url\":\"https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz\",\"metadata\":{\"optionalDependencies\":{\"@esbuild/aix-ppc64\":\"0.28.2\",\"@esbuild/android-arm\":\"0.28.2\",\"@esbuild/android-arm64\":\"0.28.2\",\"@esbuild/android-x64\":\"0.28.2\",\"@esbuild/darwin-arm64\":\"0.28.2\",\"@esbuild/darwin-x64\":\"0.28.2\",\"@esbuild/freebsd-arm64\":\"0.28.2\",\"@esbuild/freebsd-x64\":\"0.28.2\",\"@esbuild/linux-arm\":\"0.28.2\",\"@esbuild/linux-arm64\":\"0.28.2\",\"@esbuild/linux-ia32\":\"0.28.2\",\"@esbuild/linux-loong64\":\"0.28.2\",\"@esbuild/linux-mips64el\":\"0.28.2\",\"@esbuild/linux-ppc64\":\"0.28.2\",\"@esbuild/linux-riscv64\":\"0.28.2\",\"@esbuild/linux-s390x\":\"0.28.2\",\"@esbuild/linux-x64\":\"0.28.2\",\"@esbuild/netbsd-arm64\":\"0.28.2\",\"@esbuild/netbsd-x64\":\"0.28.2\",\"@esbuild/openbsd-arm64\":\"0.28.2\",\"@esbuild/openbsd-x64\":\"0.28.2\",\"@esbuild/openharmony-arm64\":\"0.28.2\",\"@esbuild/sunos-x64\":\"0.28.2\",\"@esbuild/win32-arm64\":\"0.28.2\",\"@esbuild/win32-ia32\":\"0.28.2\",\"@esbuild/win32-x64\":\"0.28.2\"},\"bin\":{\"esbuild\":\"bin/esbuild\"}},\"integrity\":\"sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==\",\"placement\":\"node_modules/esbuild\"},{\"key\":\"get-tsconfig\",\"pinned\":\"get-tsconfig@4.14.3\",\"url\":\"https://registry.npmmirror.com/get-tsconfig/-/get-tsconfig-4.14.3.tgz\",\"metadata\":{\"dependencies\":{\"resolve-pkg-maps\":\"^1.0.0\"}},\"integrity\":\"sha512-++QEw4DIY7WGoukz+/+A/8dGYPT9l9yIadnmSgZ8Rjr3YVSVDipQSO9CdnJo9ePqFqUUqh+wk9uIaoiAwsiPkA==\",\"placement\":\"node_modules/get-tsconfig\"},{\"key\":\"resolve-pkg-maps\",\"pinned\":\"resolve-pkg-maps@1.0.0\",\"url\":\"https://registry.npmmirror.com/resolve-pkg-maps/-/resolve-pkg-maps-1.0.0.tgz\",\"metadata\":{},\"integrity\":\"sha512-seS2Tj26TBVOC2NIc2rOe2y2ZO7efxITtLZcGSOnHHNOQ7CkiUBfw0Iw2ck6xkIhPwLhKNLS8BO+hEpngQlqzw==\",\"placement\":\"node_modules/resolve-pkg-maps\"},{\"key\":\"source-map\",\"pinned\":\"source-map@0.6.1\",\"url\":\"https://registry.npmmirror.com/source-map/-/source-map-0.6.1.tgz\",\"metadata\":{},\"integrity\":\"sha512-UjgapumWlbMhkBgzT7Ykc5YXUT46F0iKu8SGXq0bcwP5dz/h0Plj6enJqjz1Zbq2l5WaqYnrVbwWOWMyF3F47g==\",\"placement\":\"node_modules/source-map\"},{\"key\":\"source-map-support\",\"pinned\":\"source-map-support@0.5.21\",\"url\":\"https://registry.npmmirror.com/source-map-support/-/source-map-support-0.5.21.tgz\",\"metadata\":{\"dependencies\":{\"buffer-from\":\"^1.0.0\",\"source-map\":\"^0.6.0\"}},\"integrity\":\"sha512-uBHU3L3czsIyYXKX88fdrGovxdSCoTGDRZ6SYXtSRxLZUzHg5P/66Ht6uoUlHu9EZod+inXhKo3qQgwXUT/y1w==\",\"placement\":\"node_modules/source-map-support\"},{\"key\":\"tsx\",\"pinned\":\"tsx@4.23.12\",\"url\":\"https://registry.npmmirror.com/tsx/-/tsx-4.23.12.tgz\",\"metadata\":{\"dependencies\":{\"esbuild\":\"~0.28.0\"},\"optionalDependencies\":{\"fsevents\":\"~2.3.3\"},\"bin\":{\"tsx\":\"dist/cli.mjs\"}},\"integrity\":\"sha512-FDf4L4sYzKtzWYhU/Xm0AQFdTjdIxNo9ElTf2mxXM6k8YMHXzYUe4yODVaXP4V9uMFbVg8c0qyBccK2OOxb45Q==\",\"placement\":\"node_modules/tsx\"}],\"edges\":[{\"from\":\"drizzle-kit\",\"name\":\"@drizzle-team/brocli\",\"range\":\"^0.10.2\",\"to\":\"@drizzle-team/brocli\"},{\"from\":\"drizzle-kit\",\"name\":\"@esbuild-kit/esm-loader\",\"range\":\"^2.5.5\",\"to\":\"@esbuild-kit/esm-loader\"},{\"from\":\"drizzle-kit\",\"name\":\"esbuild\",\"range\":\"^0.25.4\",\"to\":\"drizzle-kit/esbuild\"},{\"from\":\"drizzle-kit\",\"name\":\"tsx\",\"range\":\"^4.21.0\",\"to\":\"tsx\"},{\"from\":\"@esbuild-kit/esm-loader\",\"name\":\"@esbuild-kit/core-utils\",\"range\":\"^3.3.2\",\"to\":\"@esbuild-kit/core-utils\"},{\"from\":\"@esbuild-kit/esm-loader\",\"name\":\"get-tsconfig\",\"range\":\"^4.7.0\",\"to\":\"get-tsconfig\"},{\"from\":\"drizzle-kit/esbuild\",\"name\":\"@esbuild/linux-x64\",\"range\":\"0.25.12\",\"to\":\"drizzle-kit/esbuild/@esbuild/linux-x64\",\"optional\":true},{\"from\":\"tsx\",\"name\":\"esbuild\",\"range\":\"~0.28.0\",\"to\":\"esbuild\"},{\"from\":\"@esbuild-kit/core-utils\",\"name\":\"esbuild\",\"range\":\"~0.18.20\",\"to\":\"@esbuild-kit/core-utils/esbuild\"},{\"from\":\"@esbuild-kit/core-utils\",\"name\":\"source-map-support\",\"range\":\"^0.5.21\",\"to\":\"source-map-support\"},{\"from\":\"get-tsconfig\",\"name\":\"resolve-pkg-maps\",\"range\":\"^1.0.0\",\"to\":\"resolve-pkg-maps\"},{\"from\":\"esbuild\",\"name\":\"@esbuild/linux-x64\",\"range\":\"0.28.2\",\"to\":\"@esbuild/linux-x64\",\"optional\":true},{\"from\":\"@esbuild-kit/core-utils/esbuild\",\"name\":\"@esbuild/linux-x64\",\"range\":\"0.18.20\",\"to\":\"@esbuild-kit/core-utils/esbuild/@esbuild/linux-x64\",\"optional\":true},{\"from\":\"source-map-support\",\"name\":\"buffer-from\",\"range\":\"^1.0.0\",\"to\":\"buffer-from\"},{\"from\":\"source-map-support\",\"name\":\"source-map\",\"range\":\"^0.6.0\",\"to\":\"source-map\"}],\"limits\":{\"project\":536870912,\"data\":67108864,\"swap\":0,\"preparation_seconds\":480,\"generator_seconds\":120,\"export_seconds\":120,\"stop_grace_seconds\":5},\"baseline\":{\"directory\":\"openbot/server/drizzle\",\"snapshot\":\"meta/0080_snapshot.json\",\"snapshot_bytes\":299339,\"snapshot_blob\":\"de6a0b41c088c0bd46de019cb888575c95a07bb5\",\"snapshot_tables\":99,\"recovery_stitched\":false},\"learning\":{\"removed_input\":\"./src/db/schema/learning.ts\",\"basis\":\"0078_drop_learning SQL plus0077/0078 snapshot id/prevId transition; current original0080 and recovery0107 both absent\",\"source_fabricated\":false},\"status\":\"AUTHOR_PREPARED_UNREVIEWED_NOT_RUN\",\"resource_admin\":\"A2 activation fix before runner UID/GID drop, parent and child gate checks and cgroup.kill finally; no root Subject execution.\",\"output\":\"Complete actual generated SQL/snapshot/journal captured as chunked gzip-base64 DATA in GHA logs with per-file hashes, plus full DDL status; no adoption.\",\"gates\":{\"ROOT_RELEASE\":null,\"ready\":false,\"AP_DISABLED\":true,\"NOT_SERVICE_WIRED\":true,\"migrationNOT_WIRED\":true,\"PG\":\"PG_PENDING\"},\"revision\":{\"id\":\"A11\",\"a1\":\"d824f9cc45cf13bbe198bd210514121636bca501\",\"status\":\"AUTHOR_A11_PREPARED_UNREVIEWED_NOT_RUN\",\"cleanup_reserve_seconds\":8,\"cleanup\":\"One idempotent cleanup per activated service, shared absolute deadline; bounded stop/wait remaining; no fresh finally deadline.\",\"structure\":\"Findings do not block export of real generated files.\",\"log_export_max_bytes\":16777216,\"oversized_log\":\"Prefix exported with full original identity and incomplete flag; failed outcome.\",\"a2\":\"b74eb935b96cc81d450c1a41a88763adca95cf4e\",\"late_gate\":\"Log actual cleanup remaining, assert nonnegative after restore/populated check.\",\"activation_gate\":\"Root wrapper and runner stage main require time.monotonic()<deadline-8.\",\"a3\":\"1469b2305c7135ce8f77e318dac9f2bf00757df7\",\"mode_adapter\":\"Accept only manifest strings 0o644 and100644; int(removeprefix0o,8)&07777 must equal0644; compare exact octal S_IMODE string with seal. No755, no fallback.\",\"prior_real_attempt\":{\"run\":40843372223,\"job\":123344875216,\"head\":\"e4cdae0b32411e4592788222f0a2a6786cc7320c\",\"source\":{\"batches\":74,\"files\":2065,\"bytes\":50175181,\"mode_fd_hash\":true,\"DATA\":67108864,\"swap\":0},\"failure\":\"copy verify_inputs L93 textual 100644 versus0o644 with identical bytes/hash\",\"manifest_mode_counts\":{\"100644\":71,\"0o644\":1994},\"dependencies\":\"NOT_RUN\",\"generator\":\"NOT_RUN\",\"metadata\":\"NONE\",\"terminal_parent\":{\"memory_max\":536870912,\"swap_max\":0,\"oom_group\":1,\"populated\":0},\"reviewer_log_digest\":{\"bytes\":46145,\"sha256\":\"48265e559414be5b6ab09a3d85ab614929bd121a041f9251122203b9bf85a68b\"}},\"a4\":\"c6f51d2673e608895ab826ed7437dbef9dab0340\",\"change_scope\":\"Only diagnostic overlay to initially independently reviewed two SQL zero fence default schema successor95ebc15b, exact ref/blob/bytes/hash and schema_modules identity. All formal2065 Source baseline, original17nodes/guards/FULL50/relativeout/native/resource/identity/deadline/cleanup implementation unchanged. No full schema/migration approval or adoption.\",\"a5\":\"2e1e493f2983fcecc27393a993ccc95448cbff9b\",\"a6\":\"f97260fa06af41ea8a5e7d94420de53eee99cb49\",\"a7\":\"f689c5b3c89c66a52fe883681c1256a520fc0c1a\",\"a7_pin_finding\":\"A7 workflow stale80700/5a770146 pin did not equal actual80775/4fbbc391 controller. Prior author pin-match assertion retracted. A8 constructs both workflow byte constants/hash from final controller raw bytes, then independently parses and asserts them again after GitHub full readback.\",\"a8\":\"560f711ba995dc06d0eaa38955505670bbd964d4\",\"a9\":\"d074c1cd37056b0fd77db837455dd07f983f11e8\",\"a10\":\"d153dd2b34ab63bd7027590fb8daddcfaa36ae7f\"},\"redirect_policy\":{\"basis\":{\"run\":40848414444,\"job\":123361532231,\"head_sha\":\"b2a95ba0b346b70834b30edf07855d668c0c7dc7\",\"conclusion\":\"success\",\"ref\":\"https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40848414444/job/123361532231\",\"http_status\":302,\"observed_original_url\":\"https://registry.npmmirror.com/@drizzle-team/brocli/-/brocli-0.10.2.tgz\",\"observed_location\":{\"followed\":false,\"fragment_present\":false,\"hostname\":\"cdn.npmmirror.com\",\"original_chars\":82,\"original_sha256\":\"305d8e623931fc51f4da4278776d94fe7d5af1189e4bf4d9d09fcd1d781c4982\",\"path\":\"/packages/%40drizzle-team/brocli/0.10.2/brocli-0.10.2.tgz\",\"port\":null,\"query_present\":false,\"scheme\":\"https\",\"value\":\"https://cdn.npmmirror.com/packages/%40drizzle-team/brocli/0.10.2/brocli-0.10.2.tgz\"},\"archive_body_reads\":0,\"followed_location\":false},\"initial_request\":\"Always original exact lock URL over HTTPS; no CDN substitution in lock or first request.\",\"direct_registry_200_allowed\":true,\"redirect_statuses\":[301,302,303,307,308],\"max_followed_hops\":1,\"exact_target_host\":\"cdn.npmmirror.com\",\"allowed_target_port\":\"absent or443 only\",\"target_path_derivation\":\"/packages/ + quote(pinned_package_name,safe='/') + '/' + quote(pinned_version,safe='') + '/' + quote(basename+'-'+version+'.tgz',safe='')\",\"forbidden\":[\"second redirect\",\"other host\",\"HTTP downgrade\",\"userinfo\",\"query including empty delimiter\",\"fragment including empty delimiter\",\"other port\",\"unknown package path\"],\"safe_rejection_log\":\"Reason + bounded hostname/path/port and whole-URL SHA256; no raw target URL, userinfo, query or fragment values.\",\"evidence_limit\":\"Only brocli first-hop302 and exact target were observed. Remaining16 package target paths and other standard redirect statuses are candidate constraints, not runtime facts; mismatch rejects and preserves failure.\",\"sri\":\"Original SHA512 SRI is still mandatory before any extraction.\"},\"orm_metadata_compatibility\":{\"evidence_commit\":\"2e06e7d2ecccfa57522d80e75caddede3479a478\",\"run\":40857520611,\"job\":123392107062,\"declared_difference\":\"lock_only /peerDependencies/prisma = *; actual lacks it but actual peerDependenciesMeta prisma.optional istrue\",\"guard\":\"Strict all deps equality unless only this exact pinned node,url,SRI,rawpackageJSON bytes/SHA and soleprisma optional-only representation. Everyotherpeer/range/dependency rejects.\",\"mutates_package_or_lock\":false,\"raw_package_json\":{\"bytes\":177277,\"sha256\":\"9fd30ce718965c19178ac6936462b77017f1fffe56865124d0cfe55850de09ff\"},\"contract_checks\":{\"positive_definitions\":2,\"negative_definitions\":14,\"execution\":\"NOT_RUN\",\"future_stage\":\"deps underDATA64 before downloads; synthetic identities are fixtures, not authenticated package proof\"}},\"candidate_tree_guard\":{\"baseline\":\"f97260fa06af41ea8a5e7d94420de53eee99cb49\",\"baseline_tree\":\"0877bb2bb252935d54e8f7d234c91c6703d600cf\",\"historical_source_base\":\"823744db378f508a1996f8c23faf1b42f115ad33\",\"formal_adopted_source\":\"668dd2238ff112bcff38ad2d0456dccd116874ed\",\"reason\":\"A6 inherited twenty other administrative history paths relative to old823744db. Do not whitelist or ignore them: pin exact A6 immutable tree as candidate administrative comparison base.\",\"runtime\":\"Fetch exact base and target; git diff --name-only must equal exactly workflow/controller/plan. Git diff includes content, mode, additions/deletions; every other tree entry must be identical. Independently retain original2065 Source manifest byte/hash/mode verification.\",\"source_adoption\":false},\"tsx_bin_compatibility\":{\"evidence_candidate\":\"97c63f88dfeada5f7bf3a55afecf290542657ada\",\"run\":40897218451,\"job\":123529510039,\"archive_bytes\":187918,\"original_SRI_verified\":true,\"actual_bin_type\":\"str\",\"actual_bin\":\"./dist/cli.mjs\",\"original_lock_bin\":{\"tsx\":\"dist/cli.mjs\"},\"raw_package_json\":{\"bytes\":1601,\"sha256\":\"96aee9fd252d0cc31f3c01468250961f5b338c797bc208700d7db926450c7659\"},\"guard\":\"Only exact pinned TSX node/URL/SRI/name/version/rawJSON identity + exact lock single bin/actual exact string. No generic string normalization. All nonstring bin metadata follows original strict dictionary path.\",\"contract_checks\":{\"positive_definitions\":3,\"negative_definitions\":16,\"execution\":\"NOT_RUN\",\"future_stage\":\"deps DATA64 before downloads\",\"synthetic_identity_is_fixture_not_authenticated_package\":true},\"mutates_package_or_lock\":false,\"derived_absent_peer_meta\":\"Metadata diagnostic absent versus derived empty object is representation only; existing peer validation unchanged.\"},\"relative_output_fix\":{\"prior_run\":40898247886,\"prior_job\":123533162634,\"actual_cli_exit\":0,\"actual_generated_added\":[],\"actual_generated_changed\":[],\"actual_generated_removed\":[],\"result\":\"GENERATOR_OUTPUT_SHAPE_INCOMPLETE; internal error printed despite exit0\",\"decoded_generator_log\":{\"bytes\":1196,\"sha256\":\"56bda287017f3dcb05db756b436294a741cc14d8eb651bbf8c1df59fd583ed1b\",\"gzip\":{\"bytes\":526,\"sha256\":\"a5bdb8b654af3f83e9f94d747d2daf7c488651efc683a27e02d3c10083cd9943\"},\"crc32_verified\":true,\"error_path\":\".//home/runner/work/_temp/private-drizzle/meta/0000_snapshot.json\"},\"upstream_tag\":\"drizzle-kit@0.31.10\",\"upstream_commit\":\"4aa6ecfee4b4728dadf6f77f071a149878a3c6c0\",\"upstream_references\":[{\"repository\":\"drizzle-team/drizzle-orm\",\"path\":\"drizzle-kit/package.json\",\"blob\":\"8a2625b0ff5cc3c2c847515fdeed7e6b1c5e7a31\",\"bytes\":3683,\"sha256\":\"c258e6134d938d6d718448274fd3e89ed9c05aeca7bb6bc7df22c89d943615c8\"},{\"repository\":\"drizzle-team/drizzle-orm\",\"path\":\"drizzle-kit/src/utils.ts\",\"blob\":\"bcea01c249f078e8acab380c57179f40b95f9e55\",\"bytes\":9372,\"sha256\":\"14c5dbc0b07c9570c24ca9388262fed0f3f2a0689567754a87f6b4034249a3a6\"},{\"repository\":\"drizzle-team/drizzle-orm\",\"path\":\"drizzle-kit/src/cli/commands/migrate.ts\",\"blob\":\"8c62a5edb22df5ba5216da5f8b381a354a3e40e3\",\"bytes\":35380,\"sha256\":\"c453653a3939827c6a71b991ae5b0db04a70b6d17cdd7798e5c51a7e89770b56\"}],\"source_evidence\":\"Tagged package.json version0.31.10; prepareOutFolder joins(out,'meta') and snapshot paths; validateWithReport reads './'+snapshot; prepareAndMigratePg catches and console.error without rethrow. Runtime bundled bin.cjs stack confirms same failing path; upstream references not runtime binary digest proof.\",\"cwd\":\"<RUNNER_TEMP>/private-stage/openbot/server\",\"relative_out\":\"../../../private-drizzle\",\"resolved_out\":\"<RUNNER_TEMP>/private-drizzle\",\"constraints\":\"os.path.relpath from exact safe generator cwd; relative not absolute; strict resolve equality with controlled out, out.parent==base; all schema inputs remain absolute50. Original Source config untouched.\",\"resource_stage_added\":false,\"actual_generation_proven\":false},\"serializable_default_overlay\":{\"cause_audit\":{\"commit\":\"4e66c225a8beff9d7e2c8679aba0859d135d0676\",\"path\":\"archives/recovery-20261028/CLOUD-FULL50-BIGINT-SERIALIZATION-AUDIT-20261029.json\",\"blob\":\"4c05579cc24faff4556b94b11fa2775aaa13b994\",\"bytes\":26339,\"sha256\":\"424aa47f97e7e50c9b98df8af7f06b2801ca648d56c4ee67dcb1a5a7926dcf69\"},\"initial_non_author_review\":{\"reviewer\":\"Root\",\"path\":\"archives/recovery-20261028/CLOUD-SEED-SERIALIZABLE-DEFAULTS-INITIAL-REVIEW-20261029.json\",\"subject_sha\":\"95ebc15ba4c6f53ead7a1a659565a1cdfbecf549\",\"scope\":\"INITIAL_ONE_SOURCE_APPROVED_FOR_DIAGNOSTIC_OVERLAY_ONLY; NOT_FULL_SCHEMA_MIGRATION_PACKAGE; NOT_ADOPTED\",\"commit_identity\":\"Root persisting exact report; coordinator must supply/verify exact report SHA before dispatch\"},\"overlay_source_changes\":1,\"exact_change\":\"Only two approval_continuations/approval_continuation_steps fence default(0n) to default(sql`0`); bigint mode/notNull/checks/RLS/permissions unchanged.\",\"formal_source\":{\"files\":2065,\"bytes\":50175181,\"changed\":false},\"private_copy\":{\"files\":2065,\"bytes\":50177761,\"calculation\":{\"baseline_bytes\":50175181,\"old_approvals_bytes\":10520,\"new_approvals_bytes\":13100},\"diagnostic_only\":true},\"migration_output\":\"Real generator must produce complete SQL/snapshot/journal; old handseedSQL never counts as real full output. Full generated DDL versus original/recovery chain and <=8Source full-package independent review remain pending.\"}}")
SOURCE_SCRIPT = "import base64, gzip, hashlib, io, json, os, stat, subprocess, sys, tarfile, tempfile, zipfile\nfrom pathlib import Path\n\ntarget = sys.argv[1]\nassert os.geteuid() != 0\nassert len(target) == 40 and all(c in \"0123456789abcdef\" for c in target)\ncg_lines = Path(\"/proc/self/cgroup\").read_text().splitlines()\nassert len(cg_lines) == 1 and cg_lines[0].startswith(\"0::/\")\ncg = Path(\"/sys/fs/cgroup\") / cg_lines[0][3:].lstrip(\"/\")\nassert (cg / \"memory.max\").read_text().strip() == \"67108864\"\nassert (cg / \"memory.swap.max\").read_text().strip() == \"0\"\nassert (cg / \"memory.oom.group\").read_text().strip() == \"1\"\nassert cg.parent.name == \"xiongbaowork.slice\"\nassert (cg.parent / \"memory.oom.group\").read_text().strip() == \"1\"\nassert (cg.parent / \"memory.max\").read_text().strip() == \"536870912\"\nassert (cg.parent / \"memory.swap.max\").read_text().strip() == \"0\"\nprint(\"RESOURCE_GATE \" + json.dumps({\"cgroup\": cg_lines[0], \"aggregate_memory_max\": 67108864, \"project_upper_bound\": 536870912, \"swap_max\": 0}), flush=True)\n\ndef command(args, cwd):\n    print(\"SOURCE_COMMAND_START \" + json.dumps({\"operation\": args[1], \"argument_count\": len(args)}), flush=True)\n    completed = subprocess.run([\"timeout\", \"--signal=TERM\", \"--kill-after=2s\", \"45s\",\n        \"git\", \"-c\", \"gc.auto=0\", \"-c\", \"maintenance.auto=false\",\n        \"-c\", \"core.deltaBaseCacheLimit=1m\", \"-c\", \"core.packedGitLimit=8m\",\n        \"-c\", \"core.packedGitWindowSize=1m\", \"-c\", \"pack.threads=1\", *args[1:]],\n        cwd=cwd, text=True, capture_output=True,\n        env={**os.environ, \"GIT_TERMINAL_PROMPT\": \"0\"})\n    if completed.returncode:\n        print(\"SOURCE_COMMAND_FAILURE \" + json.dumps({\"operation\": args[1], \"exit_code\": completed.returncode,\n            \"stderr\": completed.stderr[-4000:]}), flush=True)\n    completed.check_returncode()\n    print(\"SOURCE_COMMAND_END \" + json.dumps({\"operation\": args[1]}), flush=True)\n    return completed.stdout.strip()\n\ndef metadata(s):\n    return (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)\n\ndef verified_bytes(root, rel, expected_size, expected_sha, retain=False, expected_mode=None):\n    part = Path(rel)\n    assert not part.is_absolute() and \"..\" not in part.parts and part.parts[0] != \".git\"\n    assert \"\\\\\" not in rel and \"\\x00\" not in rel\n    path = root / part\n    for parent in [path, *path.parents]:\n        if parent == root:\n            break\n        assert not parent.is_symlink()\n    assert path.resolve(strict=True).is_relative_to(root)\n    named = os.stat(path, follow_symlinks=False)\n    assert stat.S_ISREG(named.st_mode) and named.st_nlink == 1 and named.st_size == expected_size, json.dumps({\"path\": rel, \"expected_bytes\": expected_size, \"actual_bytes\": named.st_size, \"nlink\": named.st_nlink, \"mode\": named.st_mode})\n    if expected_mode is not None:\n        assert stat.S_IMODE(named.st_mode) == (int(expected_mode.removeprefix(\"0o\"), 8) & 0o7777), json.dumps({\"path\": rel, \"expected_mode\": expected_mode, \"actual_mode\": oct(stat.S_IMODE(named.st_mode))})\n    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)\n    try:\n        before = os.fstat(fd)\n        assert metadata(before) == metadata(named)\n        digest = hashlib.sha256()\n        data = bytearray() if retain else None\n        count = 0\n        while True:\n            chunk = os.read(fd, 65536)\n            if not chunk:\n                break\n            count += len(chunk)\n            assert count <= expected_size\n            digest.update(chunk)\n            if retain:\n                data.extend(chunk)\n        assert count == expected_size and digest.hexdigest() == expected_sha, json.dumps({\"path\": rel, \"expected_sha256\": expected_sha, \"actual_sha256\": digest.hexdigest(), \"expected_bytes\": expected_size, \"actual_bytes\": count})\n        assert metadata(os.fstat(fd)) == metadata(before) == metadata(os.stat(path, follow_symlinks=False))\n        return bytes(data) if retain else count\n    finally:\n        os.close(fd)\n\nwork = Path.cwd() / \"xiongbaowork-verified-source\"\nwork.mkdir(mode=0o700)\nroot = Path(work) / \"repo\"\ncommand([\"git\", \"init\", \"--quiet\", str(root)], Path(work))\ncommand([\"git\", \"remote\", \"add\", \"origin\", \"https://github.com/canquedehuiyi-cpu/xiongbaowork.git\"], root)\ncommand([\"git\", \"config\", \"remote.origin.promisor\", \"true\"], root)\ncommand([\"git\", \"config\", \"remote.origin.partialclonefilter\", \"blob:none\"], root)\ncommand([\"git\", \"fetch\", \"--quiet\", \"--no-tags\", \"--filter=blob:none\", \"--depth=1\", \"origin\", target], root)\ncommand([\"git\", \"fetch\", \"--quiet\", \"--no-tags\", \"--filter=blob:none\", \"--depth=1\", \"origin\", \"f97260fa06af41ea8a5e7d94420de53eee99cb49\"], root)\nallowed_admin = set([\".github/workflows/cloud-minimal-generator.yml\",\"archives/recovery-20261028/CLOUD-MINIMAL-GENERATOR-CONTROLLER-20261029.py\",\"archives/recovery-20261028/CLOUD-MINIMAL-GENERATOR-PLAN-20261029.json\"])\nassert set(command([\"git\", \"diff\", \"--name-only\", \"f97260fa06af41ea8a5e7d94420de53eee99cb49\", target], root).splitlines()) == allowed_admin\ncontrol_path = \"archives/recovery-20261028/CURRENT-SOURCE-EXPECTED-MANIFEST.json\"\nshown = subprocess.run([\"git\", \"-c\", \"core.deltaBaseCacheLimit=1m\", \"-c\", \"pack.threads=1\",\n                        \"show\", target + \":\" + control_path], cwd=root,\n                       check=True, capture_output=True, env={**os.environ, \"GIT_TERMINAL_PROMPT\": \"0\"}).stdout\nassert len(shown) == 456310\nassert hashlib.sha256(shown).hexdigest() == \"7028278e9ff0da8e2f545964c55360c2535cba619102db4dcd0b020e23f0c632\"\nmanifest = json.loads(shown)\nassert manifest[\"file_count\"] == 2065 and manifest[\"source_bytes\"] == 50175181\noverlay_specs = []\nrecords = {f[\"path\"]: f for f in manifest[\"files\"]}\nfor specification in overlay_specs:\n    overlay_raw = subprocess.run([\"git\", \"-c\", \"core.deltaBaseCacheLimit=1m\", \"-c\", \"pack.threads=1\",\n                                  \"show\", target + \":\" + specification[\"path\"]],\n                                 cwd=root, check=True, capture_output=True,\n                                 env={**os.environ, \"GIT_TERMINAL_PROMPT\": \"0\"}).stdout\n    assert len(overlay_raw) == specification[\"bytes\"]\n    assert hashlib.sha256(overlay_raw).hexdigest() == specification[\"sha256\"]\n    overlay = json.loads(overlay_raw)\n    assert overlay[\"base_manifest_sha256\"] == \"7028278e9ff0da8e2f545964c55360c2535cba619102db4dcd0b020e23f0c632\"\n    assert overlay[\"formal_adoption\"] is specification[\"formal_adoption\"]\n    assert overlay[\"ticket\"] == specification[\"ticket\"]\n    assert len(overlay[\"changes\"]) == len(specification[\"source_paths\"])\n    assert {item[\"path\"] for item in overlay[\"changes\"]} == set(specification[\"source_paths\"])\n    for change in overlay[\"changes\"]:\n        if change[\"path\"] in set(specification.get(\"source_new_paths\", [])):\n            assert change[\"before\"] == {\"absent\": True}\n            assert change[\"path\"] not in records\n            original = {\"path\": change[\"path\"], \"bytes\": change[\"after\"][\"bytes\"],\n                        \"sha256\": change[\"after\"][\"sha256\"], \"mode\": change[\"after\"][\"mode\"]}\n            manifest[\"files\"].append(original)\n            manifest[\"file_count\"] += 1\n            records[change[\"path\"]] = original\n        else:\n            original = records[change[\"path\"]]\n            assert original[\"bytes\"] == change[\"before\"][\"bytes\"] and original[\"sha256\"] == change[\"before\"][\"sha256\"]\n            assert original[\"mode\"] == change[\"before\"][\"mode\"] == change[\"after\"][\"mode\"]\n            original[\"bytes\"] = change[\"after\"][\"bytes\"]\n            original[\"sha256\"] = change[\"after\"][\"sha256\"]\ncommand([\"git\", \"sparse-checkout\", \"init\", \"--no-cone\"], root)\ndef sparse_literal(path):\n    return \"/\" + \"\".join((\"\\\\\" + c) if c in \"\\\\*?[]!#\" else c for c in path)\n# Materialize only the small control first. Each following source batch is <=2MiB/32files.\npatterns = \"/\" + control_path + \"\\n\"\nsubprocess.run([\"git\", \"sparse-checkout\", \"set\", \"--no-cone\", \"--stdin\"], input=patterns,\n               cwd=root, check=True, text=True, capture_output=True)\ncommand([\"git\", \"checkout\", \"--quiet\", \"--detach\", target], root)\ntree_records = {}\nfor row in command([\"git\", \"ls-tree\", \"-r\", \"-z\", target], root).split(\"\\x00\"):\n    if not row:\n        continue\n    metadata_part, path = row.split(\"\\t\", 1)\n    mode, kind, oid = metadata_part.split(\" \")\n    assert kind == \"blob\" and len(oid) == 40\n    tree_records[path] = oid\nsynced_git_files = set()\ndef flush_owned_regular(path):\n    if not path.exists():\n        return\n    named = os.stat(path, follow_symlinks=False)\n    assert stat.S_ISREG(named.st_mode) and named.st_nlink == 1\n    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)\n    try:\n        assert metadata(os.fstat(fd)) == metadata(named)\n        os.fsync(fd)\n    finally:\n        os.close(fd)\ndef flush_git_transport():\n    index = root / \".git\" / \"index\"\n    if index.exists():\n        flush_owned_regular(index)\n    packs = root / \".git\" / \"objects\" / \"pack\"\n    for item in packs.iterdir():\n        if item.name.endswith((\".pack\", \".idx\", \".rev\")) and str(item) not in synced_git_files:\n            flush_owned_regular(item)\n            synced_git_files.add(str(item))\nflush_owned_regular(root / control_path)\nflush_git_transport()\nbatch = []\nbatch_bytes = 0\nbatch_count = 0\ndef materialize_batch(paths):\n    oids = sorted({tree_records[path] for path in paths})\n    command([\"git\", \"fetch\", \"--quiet\", \"--no-tags\", \"--no-write-fetch-head\",\n             \"--no-auto-maintenance\", \"--filter=blob:none\", \"origin\", *oids], root)\n    flush_git_transport()\n    command([\"git\", \"checkout\", \"--quiet\", \"--ignore-skip-worktree-bits\", target, \"--\", *paths], root)\n    print(\"SOURCE_BATCH_COMPLETE \" + json.dumps({\"files\": len(paths)}), flush=True)\n    for path in paths:\n        flush_owned_regular(root / path)\n    flush_git_transport()\nfor item in manifest[\"files\"]:\n    part = Path(item[\"path\"])\n    assert not part.is_absolute() and \"..\" not in part.parts and part.parts[0] != \".git\"\n    assert \"\\\\\" not in item[\"path\"] and \"\\x00\" not in item[\"path\"]\n    if batch and (len(batch) == 32 or batch_bytes + item[\"bytes\"] > 2097152):\n        materialize_batch(batch)\n        batch_count += 1\n        batch = []\n        batch_bytes = 0\n    assert item[\"bytes\"] <= 2097152\n    batch.append(item[\"path\"])\n    batch_bytes += item[\"bytes\"]\nif batch:\n    materialize_batch(batch)\n    batch_count += 1\nprint(\"SOURCE_BATCH_MATERIALIZATION \" + json.dumps({\"batches\": batch_count, \"max_files\": 32,\n    \"max_source_bytes\": 2097152, \"fsync_after_each_batch\": True, \"memory_limit\": 67108864}), flush=True)\nassert command([\"git\", \"rev-parse\", \"HEAD\"], root) == target\nmanifest_raw = verified_bytes(root, control_path, 456310,\n    \"7028278e9ff0da8e2f545964c55360c2535cba619102db4dcd0b020e23f0c632\", True)\nassert manifest_raw == shown\nassert manifest[\"file_count\"] == len(manifest[\"files\"]) == 2065\nassert len({f[\"path\"] for f in manifest[\"files\"]}) == 2065\ntotal = 0\nfor item in manifest[\"files\"]:\n    total += verified_bytes(root, item[\"path\"], item[\"bytes\"], item[\"sha256\"],\n                            expected_mode=item[\"mode\"])\nassert total == 50175181\ntracked = set(command([\"git\", \"ls-files\", \"-z\"], root).split(\"\\x00\"))\nassert all(f[\"path\"] in tracked for f in manifest[\"files\"])\nassert not command([\"git\", \"status\", \"--porcelain\"], root)\nwith (Path.cwd()/\"source-manifest.json\").open(\"x\") as h: json.dump(manifest,h)\nresult = {\"status\": \"SOURCE_BYTES_VERIFIED_EXPLICIT_OVERLAYS\", \"head\": target,\n          \"git_tree\": command([\"git\", \"rev-parse\", \"HEAD^{tree}\"], root),\n          \"formal_baseline\": \"Source28 canonical expected manifest; zero diagnostic overlays\", \"overlay_tickets\": [x[\"ticket\"] for x in overlay_specs], \"verified_source_files\": 2065, \"verified_source_bytes\": total,\n          \"manifest_sha256\": \"7028278e9ff0da8e2f545964c55360c2535cba619102db4dcd0b020e23f0c632\",\n          \"source_mismatches\": 0, \"file_modes_verified\": True, \"fd_named_stability_verified\": True,\n          \"aggregate_memory_limit\": 67108864, \"project_upper_bound\": 536870912, \"swap_limit\": 0,\n          \"project_tests\": \"NOT_RUN\", \"postgres17\": \"PG_PENDING\",\n          \"commercial_acceptance\": \"NOT_DELIVERED\", \"windows_source_files_written\": 0}\nresult[\"candidate_administrative_base_sha\"] = \"f97260fa06af41ea8a5e7d94420de53eee99cb49\"\nresult[\"canonical_base_sha\"] = \"823744db378f508a1996f8c23faf1b42f115ad33\"\nresult[\"adopted_source_sha\"] = \"668dd2238ff112bcff38ad2d0456dccd116874ed\"\nprint(\"SOURCE_RECOVERY_RESULT \" + json.dumps(result, sort_keys=True), flush=True)\n\n"
KEYS = ("memory.max", "memory.swap.max", "memory.oom.group")
PARENT = Path("/sys/fs/cgroup/xiongbaowork.slice")
UNITS = ("xb-min-source", "xb-min-copy", "xb-min-deps", "xb-min-generate", "xb-min-export")

def emit(kind, value):
    print(kind+" "+json.dumps(value,sort_keys=True,separators=(",",":")),flush=True)

def gate(path):
    return {n:(path/n).read_text().strip() for n in KEYS}

def own_gate(limit):
    assert os.geteuid()!=0
    line=Path("/proc/self/cgroup").read_text().strip()
    assert line.startswith("0::/") and "\n" not in line
    cg=Path("/sys/fs/cgroup")/line[3:].lstrip("/")
    assert cg.parent==PARENT
    assert gate(cg)==dict(zip(KEYS,[str(limit),"0","1"]))
    assert gate(PARENT)==dict(zip(KEYS,["536870912","0","1"]))
    emit("SUBJECT_RUNNER_RESOURCE",{"uid":os.geteuid(),"gid":os.getegid(),"cgroup":line,"own":gate(cg),"parent":gate(PARENT),"candidate_administrative_base":PLAN["base"],"formal_adopted_source":"668dd2238ff112bcff38ad2d0456dccd116874ed","schema_overlay_ref":PLAN["overlay"]["ref"],"schema_overlay_sha256":PLAN["overlay"]["sha256"],"overlay_formally_adopted":False})
    return cg

def meta(s):
    return (s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns)

def seal(path):
    named=path.lstat()
    assert stat.S_ISREG(named.st_mode) and named.st_nlink==1 and not path.is_symlink()
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd);assert meta(before)==meta(named)
        h=hashlib.sha256();n=0
        while True:
            b=os.read(fd,65536)
            if not b:break
            h.update(b);n+=len(b)
        assert meta(os.fstat(fd))==meta(before)==meta(path.lstat()) and n==before.st_size
        return {"bytes":n,"sha256":h.hexdigest(),"mode":oct(stat.S_IMODE(before.st_mode))}
    finally:os.close(fd)

def copy_regular(src,dst,mode=None):
    expected=seal(src)
    dst.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    assert not dst.exists() and not dst.is_symlink()
    with src.open("rb") as incoming,dst.open("xb") as out:
        while True:
            b=incoming.read(65536)
            if not b:break
            out.write(b);out.flush();os.fsync(out.fileno())
    os.chmod(dst,int(expected["mode"],8) if mode is None else mode)
    got=seal(dst);assert got["bytes"]==expected["bytes"] and got["sha256"]==expected["sha256"]
    assert dst.stat().st_ino!=src.stat().st_ino
    return got

def read_jsonc(path):
    s=path.read_text();out=[];inside=False;escape=False;i=0
    while i<len(s):
        c=s[i]
        if inside:
            out.append(c)
            if escape:escape=False
            elif c=="\\":escape=True
            elif c=='"':inside=False
        else:
            if c=='"':inside=True
            if c==",":
                j=i+1
                while j<len(s) and s[j].isspace():j+=1
                if j<len(s) and s[j] in "}]":i+=1;continue
            out.append(c)
        i+=1
    return json.loads("".join(out))

def subprocess_checked(args,seconds=20,cwd=None):
    r=subprocess.run(args,cwd=cwd,env=CLEAN,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds)
    assert len(r.stdout)+len(r.stderr)<=1048576
    if r.returncode:
        emit("CHILD_FAILURE",{"operation":str(args[0]),"exit":r.returncode,"stderr":r.stderr[-2000:].decode(errors="replace")})
    r.check_returncode()
    return r.stdout

def verify_inputs(root,manifest,overlay=False):
    total=0
    for item in manifest["files"]:
        # The pinned manifest uses two representations of the same regular0644
        # permission. Reject every other string instead of accepting a fallback.
        manifest_mode=item["mode"]
        assert isinstance(manifest_mode,str) and manifest_mode in ("0o644","100644"),"unreviewed manifest mode"
        expected_mode=int(manifest_mode.removeprefix("0o"),8)&0o7777
        assert expected_mode==0o644
        s=seal(root/item["path"]);wanted={"bytes":item["bytes"],"sha256":item["sha256"],"mode":oct(expected_mode)}
        if overlay and item["path"]==PLAN["overlay"]["path"]:
            wanted={**wanted,"bytes":PLAN["overlay"]["bytes"],"sha256":PLAN["overlay"]["sha256"]}
        assert s==wanted,{"path":item["path"],"actual":s,"expected":wanted}
        total+=s["bytes"]
    assert len(manifest["files"])==2065
    emit("SOURCE_RECHECK",{"overlay":overlay,"files":2065,"bytes":total,"formal_adoption":False})
    return total

def prepare_copy(base,target):
    own_gate(67108864)
    original=base/"xiongbaowork-verified-source/repo"
    manifest=json.loads((base/"source-manifest.json").read_text())
    assert verify_inputs(original,manifest)==50175181
    stage=base/"private-stage"
    stage.mkdir(mode=0o700)
    for item in manifest["files"]:copy_regular(original/item["path"],stage/item["path"])
    overlay=PLAN["overlay"];git=original
    subprocess_checked(["git","-c","gc.auto=0","-c","maintenance.auto=false","fetch","--quiet","--no-tags","--filter=blob:none","--depth=1","origin",overlay["ref"]],45,git)
    data=subprocess_checked(["git","show",overlay["ref"]+":"+overlay["path"]],45,git)
    assert len(data)==overlay["bytes"] and hashlib.sha256(data).hexdigest()==overlay["sha256"]
    assert hashlib.sha1(("blob "+str(len(data))+"\0").encode()+data).hexdigest()==overlay["blob"]
    before=seal(stage/overlay["path"])
    after=stage/overlay["path"];after.unlink()
    with after.open("xb") as h:h.write(data);h.flush();os.fsync(h.fileno())
    os.chmod(after,0o644)
    emit("DIAGNOSTIC_ONLY_SCHEMA_OVERLAY",{"path":overlay["path"],"before":before,"after":seal(after),"reference":overlay["ref"],"adopted":False})
    verify_inputs(stage,manifest,True)
    schema_paths=[stage/"openbot/server"/p.removeprefix("./") for p in PLAN["schema_paths"]]
    assert len(schema_paths)==50 and len(set(schema_paths))==50 and all(p.is_file() for p in schema_paths)
    assert not (stage/"openbot/server/src/db/schema/learning.ts").exists()
    listed={p.name for p in schema_paths}
    actual={p.name for p in (stage/"openbot/server/src/db/schema").glob("*.ts")}
    assert actual==listed|{"index.ts","json.ts","tenant.ts"}
    out=base/"private-drizzle"
    out.mkdir(mode=0o700)
    source=original/"openbot/server/drizzle"
    before_files={}
    for current,dirs,files in os.walk(source,followlinks=False):
        for d in dirs:assert not (Path(current)/d).is_symlink()
        for name in files:
            f=Path(current)/name;rel=f.relative_to(source).as_posix()
            before_files[rel]=copy_regular(f,out/rel)
    snap=json.loads((out/"meta/0080_snapshot.json").read_text())
    journal=json.loads((out/"meta/_journal.json").read_text())
    assert len(snap["tables"])==99 and snap["id"]=="9830a73c-12c1-4c08-89a9-894184de1449"
    assert len(journal["entries"])==81 and journal["entries"][-1]["idx"]==80
    assert not any("learning" in p for p in snap["tables"])
    (base/"drizzle-before.json").write_text(json.dumps(before_files))
    generator_cwd=stage/"openbot/server"
    assert base.is_absolute() and out.parent==base and out.name=="private-drizzle"
    assert generator_cwd.resolve(strict=True)==base/"private-stage/openbot/server"
    assert not out.is_symlink() and out.resolve(strict=True)==out
    relative_out=os.path.relpath(out,start=generator_cwd)
    assert not Path(relative_out).is_absolute() and relative_out=="../../../private-drizzle"
    assert (generator_cwd/relative_out).resolve(strict=True)==out.resolve(strict=True)
    assert all(p.is_absolute() for p in schema_paths)
    config={"dialect":"postgresql","schema":[str(p) for p in schema_paths],"out":relative_out}
    emit("OFFLINE_OUTPUT_PATH_BINDING",{"cwd":str(generator_cwd),"out_relative":relative_out,"out_resolved":str(out.resolve(strict=True)),"schema_paths_absolute":True,"schema_modules":50,"original_Source_config_changed":False})
    with (base/"offline.config.cjs").open("x") as h:h.write("module.exports = "+json.dumps(config)+";\n")
    emit("OFFLINE_FULL50_PREPARED",{"schema_files":50,"runtime_helpers":["json.ts","tenant.ts"],"complete_source_copy":2065,"learning_removed_with0078_evidence":True,"original_drizzle_tables":99,"recovery_stitched":False,"credentials":False})

def fetch_archive(url,dest,integrity,deadline):
    # The original lock URL/SRI remains the request root for every package.
    nodes=[node for node in PLAN["nodes"] if node["url"]==url and node["integrity"]==integrity]
    assert len(nodes)==1
    node=nodes[0]
    assert url.startswith("https://registry.npmmirror.com/") and integrity.startswith("sha512-")
    pinned_name,pinned_version=node["pinned"].rsplit("@",1)
    basename=pinned_name.rsplit("/",1)[-1]
    expected_path="/packages/"+urllib.parse.quote(pinned_name,safe="/")+"/"+urllib.parse.quote(pinned_version,safe="")+"/"+urllib.parse.quote(basename+"-"+pinned_version+".tgz",safe="")
    def safe_target(value):
        result={"url_chars":len(value),"url_sha256":hashlib.sha256(value.encode("utf8","surrogatepass")).hexdigest()}
        try:
            parsed=urllib.parse.urlsplit(value)
            host=parsed.hostname
            if host is not None and len(host)<=253 and all(c.isascii() and (c.isalnum() or c in ".-") for c in host):result["hostname"]=host
            else:result["hostname"]="<invalid-or-absent>"
            path=parsed.path
            result["path"]=path[:512] if all(ord(c)>=32 and ord(c)!=127 for c in path) else "<invalid-control>"
            result["path_truncated"]=len(path)>512
            result["scheme"]=parsed.scheme if parsed.scheme in ("http","https") else "<other>"
            result["query_present"]=bool(parsed.query) or "?" in value
            result["fragment_present"]=bool(parsed.fragment) or "#" in value
            result["userinfo_present"]=parsed.username is not None or parsed.password is not None
            try:result["port"]=parsed.port
            except ValueError:result["port_invalid"]=True
        except ValueError:result["parse_error"]=True
        return result
    def refused(reason,value):
        emit("PINNED_REDIRECT_REJECTED",{"package":node["pinned"],"reason":reason,"target":safe_target(value),"followed_this_rejected_target":False})
        raise RuntimeError("pinned_redirect_refused:"+reason)
    def target_check(value):
        if len(value)>2048 or any(ord(c)<=32 or ord(c)==127 for c in value):refused("target_length_or_control",value)
        try:
            parsed=urllib.parse.urlsplit(value)
            port=parsed.port
        except ValueError:refused("target_parse",value)
        if parsed.scheme!="https":refused("target_not_https",value)
        if parsed.username is not None or parsed.password is not None:refused("target_userinfo",value)
        if parsed.hostname!="cdn.npmmirror.com" or parsed.netloc not in ("cdn.npmmirror.com","cdn.npmmirror.com:443"):refused("target_host",value)
        if port not in (None,443):refused("target_port",value)
        if parsed.query or parsed.fragment or "?" in value or "#" in value:refused("target_query_or_fragment",value)
        if parsed.path!=expected_path:refused("target_package_path",value)
    class PinnedSingleRedirect(urllib.request.HTTPRedirectHandler):
        def __init__(self):
            super().__init__();self.followed=0;self.accepted_target=None
        def pre_follow(self,req,code,headers,value):
            if self.followed!=0 or req.full_url!=url:refused("second_hop_or_nonoriginal_source",value)
            if code not in (301,302,303,307,308):refused("redirect_status",value)
            if len(headers.get_all("Location",[]))!=1:refused("location_header_count",value)
            if time.monotonic()>=deadline:refused("deadline",value)
            target_check(value)
        def http_error_302(self,req,fp,code,msg,headers):
            # Validate the raw Location before stdlib normalization or any follow.
            locations=headers.get_all("Location",[])
            value=locations[0] if locations else ""
            self.pre_follow(req,code,headers,value)
            return super().http_error_302(req,fp,code,msg,headers)
        http_error_301=http_error_302
        http_error_303=http_error_302
        http_error_307=http_error_302
        http_error_308=http_error_302
        def redirect_request(self,req,fp,code,msg,headers,newurl):
            # Check stdlib's normalized target again BEFORE it can issue a request.
            self.pre_follow(req,code,headers,newurl)
            redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
            if redirected is None:refused("stdlib_refused",newurl)
            self.followed=1;self.accepted_target=newurl
            emit("PINNED_REDIRECT_PERMITTED",{"package":node["pinned"],"status":code,"source_original_lock_url":url,"target":safe_target(newurl),"expected_package_path":expected_path,"followed_hop_budget":1,"SRI_verified":False})
            return redirected
    handler=PinnedSingleRedirect()
    opener=urllib.request.build_opener(handler)
    h=hashlib.sha512();n=0
    assert time.monotonic()<deadline
    with opener.open(urllib.request.Request(url,method="GET"),timeout=min(30,max(1,deadline-time.monotonic()))) as incoming,dest.open("xb") as out:
        final_url=incoming.geturl()
        if handler.followed==0:
            if final_url!=url:refused("unexpected_direct_response_url",final_url)
        else:
            if handler.followed!=1 or final_url!=handler.accepted_target:refused("unexpected_redirect_response_url",final_url)
            target_check(final_url)
        if incoming.getcode()!=200:refused("final_status_not200",final_url)
        while True:
            assert time.monotonic()<deadline
            b=incoming.read(65536)
            if not b:break
            n+=len(b);assert n<=33554432
            h.update(b);out.write(b);out.flush();os.fsync(out.fileno())
    assert base64.b64encode(h.digest()).decode()==integrity.removeprefix("sha512-")
    emit("PINNED_ARCHIVE_SRI_VERIFIED",{"package":node["pinned"],"original_lock_url":url,"original_lock_SRI":integrity,"bytes":n,"followed_hops":handler.followed,"SRI_verified_before_extraction":True})
    return n

def extract_archive(archive,dest,deadline):
    assert not dest.exists();dest.mkdir(mode=0o700,parents=True)
    paths=set();total=0;count=0
    with archive.open("rb") as raw,tarfile.open(fileobj=raw,mode="r|gz") as tar:
        for member in tar:
            assert time.monotonic()<deadline
            name=member.name
            assert "\\" not in name and "\0" not in name
            p=PurePosixPath(name)
            assert not p.is_absolute() and ".." not in p.parts and p.parts and p.parts[0]=="package"
            assert member.type in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE) and not member.sparse and not member.linkname,"link, sparse or special archive member rejected"
            assert not member.issym() and not member.islnk()
            rel=PurePosixPath(*p.parts[1:])
            if str(rel)==".":assert member.isdir();continue
            assert str(rel) not in paths,"duplicate archive path"
            paths.add(str(rel));target=dest/str(rel)
            assert target.resolve().is_relative_to(dest)
            for parent in target.parents:
                if parent==dest:break
                assert not parent.is_symlink()
            if member.isdir():target.mkdir(mode=0o700,parents=True,exist_ok=True);continue
            assert 0<=member.size<=33554432
            total+=member.size;count+=1;assert total<=134217728 and count<=20000
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            incoming=tar.extractfile(member);assert incoming is not None
            got=0
            with incoming,target.open("xb") as out:
                while True:
                    b=incoming.read(65536)
                    if not b:break
                    got+=len(b);assert got<=member.size
                    out.write(b);out.flush();os.fsync(out.fileno())
            assert got==member.size
            os.chmod(target,0o700 if member.mode&0o111 else 0o600)
            seal(target)
    return {"files":count,"bytes":total}


def verify_declared_dependency_metadata(package,node,raw_identity):
    """Strict equality by default; one SRI/package-identity-bound observed representation."""
    for key in ("dependencies","optionalDependencies","peerDependencies"):
        actual=package.get(key,{})
        wanted=node["metadata"].get(key,{})
        if actual==wanted:
            continue
        assert key=="peerDependencies",{"package":node["key"],"metadata_key":key}
        assert node["key"]=="drizzle-orm" and node["pinned"]=="drizzle-orm@0.45.2"
        assert node["url"]=="https://registry.npmmirror.com/drizzle-orm/-/drizzle-orm-0.45.2.tgz"
        assert node["integrity"]=="sha512-kY0BSaTNYWnoDMVoyY8uxmyHjpJW1geOmBMdSSicKo9CIIWkSxMIj2rkeSR51b8KAPB7m+qysjuHme5nKP+E5Q=="
        assert package.get("name")=="drizzle-orm" and package.get("version")=="0.45.2"
        assert raw_identity=={"bytes":177277,"sha256":"9fd30ce718965c19178ac6936462b77017f1fffe56865124d0cfe55850de09ff"}
        assert isinstance(actual,dict) and isinstance(wanted,dict)
        expected=dict(wanted)
        assert expected.pop("prisma",None)=="*" and "prisma" not in actual
        assert actual==expected,{"package":node["key"],"metadata_key":key}
        optional=node["metadata"].get("optionalPeers",[])
        assert isinstance(optional,list) and len(optional)==len(set(optional)) and "prisma" in optional
        assert set(optional)==set(wanted)
        assert package.get("peerDependenciesMeta")=={name:{"optional":True} for name in optional}
        return "exact_orm0452_optional_prisma_representation"
    return "strict_equal"

def metadata_guard_contract_checks():
    # Synthetic CPU fixtures only, never package authentication or actual generator proof.
    node=json.loads(json.dumps(next(n for n in PLAN["nodes"] if n["key"]=="drizzle-orm")))
    package={"name":"drizzle-orm","version":"0.45.2","peerDependencies":dict(node["metadata"]["peerDependencies"]),
             "peerDependenciesMeta":{name:{"optional":True} for name in node["metadata"]["optionalPeers"]}}
    identity={"bytes":177277,"sha256":"9fd30ce718965c19178ac6936462b77017f1fffe56865124d0cfe55850de09ff"}
    assert verify_declared_dependency_metadata(package,node,identity)=="strict_equal"
    del package["peerDependencies"]["prisma"]
    assert verify_declared_dependency_metadata(package,node,identity)=="exact_orm0452_optional_prisma_representation"
    changes=[
        ("other_node",lambda n,p,i:n.update(key="other")),
        ("other_pin",lambda n,p,i:n.update(pinned="drizzle-orm@0.45.3")),
        ("other_url",lambda n,p,i:n.update(url="https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.2.tgz")),
        ("other_sri",lambda n,p,i:n.update(integrity="sha512-other")),
        ("other_json_hash",lambda n,p,i:i.update(sha256="0"*64)),
        ("other_json_size",lambda n,p,i:i.update(bytes=177278)),
        ("different_version",lambda n,p,i:p.update(version="0.45.3")),
        ("missing_other_peer",lambda n,p,i:p["peerDependencies"].pop("pg")),
        ("different_peer_range",lambda n,p,i:p["peerDependencies"].update(pg=">=9")),
        ("new_actual_peer",lambda n,p,i:p["peerDependencies"].update(unexpected="*")),
        ("lost_optional_marker",lambda n,p,i:p["peerDependenciesMeta"].pop("prisma")),
        ("changed_optional_marker",lambda n,p,i:p["peerDependenciesMeta"].update(prisma={"optional":False})),
        ("different_dependencies",lambda n,p,i:p.update(dependencies={"unexpected":"*"})),
        ("different_optional_dependencies",lambda n,p,i:p.update(optionalDependencies={"unexpected":"*"})),
    ]
    for name,mutate in changes:
        n,p,i=json.loads(json.dumps([node,package,identity]))
        mutate(n,p,i)
        try:
            verify_declared_dependency_metadata(p,n,i)
        except AssertionError:
            continue
        raise AssertionError("metadata negative boundary accepted: "+name)
    emit("METADATA_GUARD_CONTRACT_CHECKS",{"positive":2,"negative":len(changes),"synthetic_only":True,"actual_package_authentication":False})

def verify_package_bin_metadata(package,node,raw_identity):
    """Original dictionary comparison; one fixed observed TSX string representation."""
    expected_bin=node["metadata"]["bin"];actual_bin=package["bin"]
    if isinstance(expected_bin,dict) and isinstance(actual_bin,dict):
        assert {k:v.removeprefix("./") for k,v in actual_bin.items()}=={k:v.removeprefix("./") for k,v in expected_bin.items()}
        return "strict_dictionary"
    assert node["key"]=="tsx" and node["pinned"]=="tsx@4.23.12"
    assert node["url"]=="https://registry.npmmirror.com/tsx/-/tsx-4.23.12.tgz"
    assert node["integrity"]=="sha512-FDf4L4sYzKtzWYhU/Xm0AQFdTjdIxNo9ElTf2mxXM6k8YMHXzYUe4yODVaXP4V9uMFbVg8c0qyBccK2OOxb45Q=="
    assert package.get("name")=="tsx" and package.get("version")=="4.23.12"
    assert raw_identity=={"bytes":1601,"sha256":"96aee9fd252d0cc31f3c01468250961f5b338c797bc208700d7db926450c7659"}
    assert type(expected_bin) is dict and expected_bin=={"tsx":"dist/cli.mjs"}
    assert type(actual_bin) is str and actual_bin=="./dist/cli.mjs"
    assert actual_bin[2:]==expected_bin["tsx"]=="dist/cli.mjs"
    return "exact_tsx42312_bin_representation"

def bin_guard_contract_checks():
    # Synthetic CPU fixtures, not real package authentication or generator proof.
    node=json.loads(json.dumps(next(n for n in PLAN["nodes"] if n["key"]=="tsx")))
    package={"name":"tsx","version":"4.23.12","bin":"./dist/cli.mjs"}
    identity={"bytes":1601,"sha256":"96aee9fd252d0cc31f3c01468250961f5b338c797bc208700d7db926450c7659"}
    assert verify_package_bin_metadata(package,node,identity)=="exact_tsx42312_bin_representation"
    strict_package={"name":"tsx","version":"4.23.12","bin":{"tsx":"./dist/cli.mjs"}}
    assert verify_package_bin_metadata(strict_package,node,identity)=="strict_dictionary"
    assert verify_package_bin_metadata({"bin":{"other":"./bin.cjs"}},{"metadata":{"bin":{"other":"bin.cjs"}}},{})=="strict_dictionary"
    changes=[
        ("other_node",lambda n,p,i:n.update(key="other")),
        ("other_pin",lambda n,p,i:n.update(pinned="tsx@4.23.13")),
        ("other_url",lambda n,p,i:n.update(url="https://registry.npmjs.org/tsx/-/tsx-4.23.12.tgz")),
        ("other_sri",lambda n,p,i:n.update(integrity="sha512-other")),
        ("other_json_hash",lambda n,p,i:i.update(sha256="0"*64)),
        ("other_json_size",lambda n,p,i:i.update(bytes=1602)),
        ("different_package_name",lambda n,p,i:p.update(name="other")),
        ("different_package_version",lambda n,p,i:p.update(version="4.23.13")),
        ("lock_bin_name",lambda n,p,i:n["metadata"].update(bin={"other":"dist/cli.mjs"})),
        ("lock_bin_path",lambda n,p,i:n["metadata"].update(bin={"tsx":"dist/other.mjs"})),
        ("lock_extra_entry",lambda n,p,i:n["metadata"].update(bin={"tsx":"dist/cli.mjs","extra":"dist/cli.mjs"})),
        ("lock_bin_type",lambda n,p,i:n["metadata"].update(bin="dist/cli.mjs")),
        ("actual_type",lambda n,p,i:p.update(bin=["./dist/cli.mjs"])),
        ("actual_target",lambda n,p,i:p.update(bin="./dist/other.mjs")),
        ("actual_raw_target_no_dot",lambda n,p,i:p.update(bin="dist/cli.mjs")),
        ("actual_traversal_target",lambda n,p,i:p.update(bin="./dist/../dist/cli.mjs")),
    ]
    for name,mutate in changes:
        n,p,i=json.loads(json.dumps([node,package,identity]))
        mutate(n,p,i)
        try:
            verify_package_bin_metadata(p,n,i)
        except AssertionError:
            continue
        raise AssertionError("bin negative boundary accepted: "+name)
    emit("BIN_GUARD_CONTRACT_CHECKS",{"positive":3,"negative":len(changes),"synthetic_only":True,"actual_package_authentication":False})

def prepare_dependencies(base,deadline):
    own_gate(67108864)
    metadata_guard_contract_checks()
    bin_guard_contract_checks()
    stage=base/"private-stage/openbot"
    lock=read_jsonc(stage/"bun.lock")
    cache=base/"private-generator-cache";cache.mkdir(mode=0o700)
    records=[]
    for node in PLAN["nodes"]:
        assert lock["packages"][node["key"]]==[node["pinned"],node["url"],node["metadata"],node["integrity"]]
        dest=stage/node["placement"]
        cache_id=hashlib.sha256(node["key"].encode()).hexdigest()
        archive=cache/(cache_id+".tgz")
        download=fetch_archive(node["url"],archive,node["integrity"],deadline)
        unpacked=cache/(cache_id+".unpacked")
        extracted=extract_archive(archive,unpacked,deadline)
        package_raw=(unpacked/"package.json").read_bytes()
        package=json.loads(package_raw.decode("utf8"))
        package_identity={"bytes":len(package_raw),"sha256":hashlib.sha256(package_raw).hexdigest()}
        pinned=node["pinned"];split=pinned.rfind("@")
        assert package["name"]==pinned[:split] and package["version"]==pinned[split+1:]
        metadata_validation=verify_declared_dependency_metadata(package,node,package_identity)
        emit("PINNED_METADATA_VALIDATION",{"package":node["pinned"],"mode":metadata_validation,"package_json":package_identity,"SRI_already_verified":True})
        if "bin" in node["metadata"]:
            bin_validation=verify_package_bin_metadata(package,node,package_identity)
            emit("PINNED_BIN_VALIDATION",{"package":node["pinned"],"mode":bin_validation,"package_json":package_identity,"SRI_already_verified":True})
        if "optionalPeers" in node["metadata"]:
            assert sorted(k for k,v in package.get("peerDependenciesMeta",{}).items() if v.get("optional"))==sorted(node["metadata"]["optionalPeers"])
        for key in ("os","cpu"):
            if key in node["metadata"]:assert node["metadata"][key] in [package.get(key),*(package.get(key,[]) if isinstance(package.get(key),list) else [])]
        for current,dirs,files in os.walk(unpacked,followlinks=False):
            for name in dirs:assert not (Path(current)/name).is_symlink()
            for name in files:
                src=Path(current)/name;copy_regular(src,dest/src.relative_to(unpacked))
        records.append({"key":node["key"],"version":package["version"],"download_bytes":download,"extracted":extracted,"placement":node["placement"],"hooks":"NOT_RUN"})
        emit("PINNED_PACKAGE_PREPARED",records[-1])
    for current,dirs,files in os.walk(stage/"node_modules",followlinks=False):
        for name in dirs:assert not (Path(current)/name).is_symlink()
        for name in files:seal(Path(current)/name)
    (base/"dependency-records.json").write_text(json.dumps(records))
    manifest=json.loads((base/"source-manifest.json").read_text())
    verify_inputs(base/"private-stage",manifest,True)
    verify_inputs(base/"xiongbaowork-verified-source/repo",manifest)
    emit("MINIMAL_DEPENDENCIES_READY",{"packages":17,"private_cache":True,"links":0,"hooks":"NOT_RUN","full_workspace_install":"NOT_RUN","optional_db_peers_installed":False})

def generate(base,deadline):
    own_gate(536870912)
    node=shutil.which("node");assert node
    emit("ACTUAL_NODE",{"path":node,"version":subprocess_checked([node,"--version"],5).decode().strip()})
    stage=base/"private-stage/openbot"
    for edge in PLAN["edges"]:
        parent=next(n for n in PLAN["nodes"] if n["key"]==edge["from"])
        expected=next(n for n in PLAN["nodes"] if n["key"]==edge["to"])
        code="const {createRequire}=require('node:module');const fs=require('node:fs');const path=require('node:path');const r=createRequire(process.argv[1]+'/package.json');let p;try{p=r.resolve(process.argv[2]+'/package.json')}catch(e){p=r.resolve(process.argv[2])}const root=fs.realpathSync(process.argv[3]);let dir=fs.realpathSync(p);while(!fs.existsSync(path.join(dir,'package.json'))){const up=path.dirname(dir);if(up===dir)throw Error('package root absent');dir=up}if(dir!==root)throw Error('nested resolution mismatch');"
        subprocess_checked([node,"-e",code,str(stage/parent["placement"]),edge["name"],str(stage/expected["placement"])],min(10,max(1,deadline-time.monotonic())))
    for key,version in [("@esbuild-kit/core-utils/esbuild","0.18.20"),("drizzle-kit/esbuild","0.25.12"),("esbuild","0.28.2")]:
        pkg=next(n for n in PLAN["nodes"] if n["key"]==key)
        native=next(n for n in PLAN["nodes"] if n["pinned"]=="@esbuild/linux-x64@"+version)
        actual=subprocess_checked([str(stage/native["placement"]/"bin/esbuild"),"--version"],min(10,max(1,deadline-time.monotonic()))).decode().strip()
        assert actual==version
        code="const m=require(process.argv[1]); if(m.version!==process.argv[2])throw Error('version mismatch'); const out=m.transformSync('const a = 1',{minify:true}); if(!out.code)throw Error('native transform empty'); console.log(m.version)"
        resolved=subprocess_checked([node,"-e",code,str(stage/pkg["placement"]),version],min(10,max(1,deadline-time.monotonic()))).decode().strip()
        assert resolved==version
        emit("ESBUILD_NATIVE_NO_HOOK",{"version":version,"direct":actual,"js_api_transform":resolved})
    assert json.loads((stage/"node_modules/drizzle-kit/package.json").read_text())["version"]=="0.31.10"
    assert json.loads((stage/"node_modules/drizzle-orm/package.json").read_text())["version"]=="0.45.2"
    generator_cwd=stage/"server"
    expected_out=base/"private-drizzle"
    assert base.is_absolute() and generator_cwd.resolve(strict=True)==base/"private-stage/openbot/server"
    assert expected_out.parent==base and not expected_out.is_symlink()
    assert expected_out.resolve(strict=True)==expected_out
    assert (generator_cwd/"../../../private-drizzle").resolve(strict=True)==expected_out
    cli=stage/"node_modules/drizzle-kit/bin.cjs"
    args=[node,"--max-old-space-size=384",str(cli),"generate","--config="+str(base/"offline.config.cjs"),"--name=full50_approval_seed_diagnostic"]
    code=1
    with (base/"generator.log").open("xb") as log:
        try:
            result=subprocess.run(args,cwd=generator_cwd,env=CLEAN,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,deadline-time.monotonic()-5))
            code=result.returncode
        except subprocess.TimeoutExpired:code=124
        log.flush();os.fsync(log.fileno())
    log_bytes=(base/"generator.log").stat().st_size
    log_evidence_complete=log_bytes<=16777216
    result={"exit_code":code,"kit":"0.31.10","orm":"0.45.2","schema_modules":50,"generator":"ACTUALLY_INVOKED","metadata":"PENDING_EXPORT","log_bytes":log_bytes,"log_evidence_complete":log_evidence_complete,"migration":"NOT_RUN","postgres":"PG_PENDING","adopted":False}
    (base/"generator-result.json").write_text(json.dumps(result))
    emit("ACTUAL_OFFLINE_GENERATOR_RESULT",result)
    # Export runs even on generator failure. Never turn a partial output into success.
    return code

def export_data(base):
    own_gate(67108864)
    manifest=json.loads((base/"source-manifest.json").read_text())
    verify_inputs(base/"private-stage",manifest,True)
    verify_inputs(base/"xiongbaowork-verified-source/repo",manifest)
    before=json.loads((base/"drizzle-before.json").read_text())
    out=base/"private-drizzle";after={}
    for current,dirs,files in os.walk(out,followlinks=False):
        for name in dirs:assert not (Path(current)/name).is_symlink()
        for name in files:
            f=Path(current)/name;after[f.relative_to(out).as_posix()]=seal(f)
    added=sorted(set(after)-set(before));changed=sorted(k for k in before if k in after and before[k]!=after[k]);removed=sorted(set(before)-set(after))
    result=json.loads((base/"generator-result.json").read_text()) if (base/"generator-result.json").exists() else {"exit_code":None,"generator":"NO_RESULT"}
    emit("FULL_GENERATED_DDL_DIFF",{"added":added,"changed":changed,"removed":removed,"generator":result,"adopted":False})
    findings=[]
    complete=result["exit_code"]==0 and not removed and set(changed)<=set(["meta/_journal.json"]) and "meta/0081_snapshot.json" in added and len([p for p in added if p.endswith(".sql")])==1
    if not complete:findings.append({"id":"GENERATOR_OUTPUT_SHAPE_INCOMPLETE","detail":"Generator exit or actual added/changed/removed shape is not the expected complete candidate."})
    if complete:
        try:
            snap=json.loads((out/"meta/0081_snapshot.json").read_text())
            journal=json.loads((out/"meta/_journal.json").read_text())
            old=json.loads((out/"meta/0080_snapshot.json").read_text())
            assert snap["prevId"]==old["id"] and snap["id"]!=old["id"],"snapshot lineage mismatch"
            assert len(snap["tables"])==156 and "public.approval_fresh_seeds" in snap["tables"],"snapshot full50 table coverage mismatch"
            assert set(old["tables"])<=set(snap["tables"]),"old tables missing from snapshot"
            assert len(journal["entries"])==82 and journal["entries"][-1]["idx"]==81,"journal shape mismatch"
            emit("FULL_SNAPSHOT_STRUCTURE",{"tables":len(snap["tables"]),"id":snap["id"],"prevId":snap["prevId"],"chain":"private_original0080","recovery_stitched":False,"ddl_review":"PENDING"})
        except (AssertionError,KeyError,TypeError,ValueError,OSError) as error:
            complete=False
            findings.append({"id":"GENERATED_STRUCTURE_UNEXPECTED","error_type":type(error).__name__,"detail":str(error)[:1000]})
    emit("GENERATOR_STRUCTURE_FINDINGS",{"findings":findings,"export_actual_before_failure":True})
    # Structure mismatches never suppress real generated SQL/snapshot/journal.
    # Every added/changed regular file is streamed, even when candidate structure is invalid.
    export_paths=[("generated/"+rel,out/rel,None) for rel in added+changed]
    if (base/"generator.log").exists():export_paths.append(("diagnostic/generator.log",base/"generator.log",16777216))
    for rel,f,maximum in export_paths:
        identity=seal(f)
        exported_bytes=identity["bytes"] if maximum is None else min(identity["bytes"],maximum)
        full_file=exported_bytes==identity["bytes"]
        if not full_file:
            complete=False
            findings.append({"id":"LOG_EVIDENCE_OVERSIZE","path":rel,"original_bytes":identity["bytes"],"exported_prefix_bytes":exported_bytes,"complete_file":False})
        packed=base/("export-"+hashlib.sha256(rel.encode()).hexdigest()+".gz")
        export_hash=hashlib.sha256();written=0
        with f.open("rb") as incoming,packed.open("xb") as raw:
            with gzip.GzipFile(fileobj=raw,mode="wb",mtime=0) as gz:
                while written<exported_bytes:
                    b=incoming.read(min(65536,exported_bytes-written))
                    assert b,"file shortened while exporting"
                    written+=len(b);export_hash.update(b);gz.write(b)
            raw.flush();os.fsync(raw.fileno())
        assert seal(f)==identity and written==exported_bytes
        gzseal=seal(packed)
        emit("GENERATED_DATA_HEADER",{"path":rel,"original_identity":identity,"exported_bytes":exported_bytes,"exported_sha256":export_hash.hexdigest(),"complete_file":full_file,"gzip_bytes":gzseal["bytes"],"gzip_sha256":gzseal["sha256"],"adopted":False})
        with packed.open("rb") as h:
            index=0
            while True:
                b=h.read(24000)
                if not b:break
                emit("GENERATED_DATA_CHUNK",{"path":rel,"index":index,"base64":base64.b64encode(b).decode()});index+=1
        emit("GENERATED_DATA_END",{"path":rel,"chunks":index,"complete_file":full_file,"exported_bytes":exported_bytes})
    emit("GENERATOR_CANDIDATE_TERMINAL",{"metadata_complete":complete,"findings":findings,"log_export_limit_bytes":16777216,"formal_adoption":False,"ROOT_RELEASE":None,"ready":False,"PG":"PG_PENDING"})
    return 0 if complete else 1

def admin_run(base,target,uid,gid):
    assert os.geteuid()==0 and uid!=0
    controller=Path(__file__).resolve()
    subprocess.run(["systemctl","daemon-reload"],timeout=10,check=True)
    slice_unit=Path("/run/systemd/system/xiongbaowork.slice")
    with slice_unit.open("x") as h:h.write("[Unit]\nDescription=Serial bounded minimal generator\n[Slice]\nMemoryMax=512M\nMemorySwapMax=0\n")
    subprocess.run(["systemctl","daemon-reload"],timeout=10,check=True)
    subprocess.run(["systemctl","start","xiongbaowork.slice"],timeout=10,check=True)
    def restore():
        if PARENT.exists():
            for n,v in zip(KEYS,["536870912","0","1"]):(PARENT/n).write_text(v)
            assert gate(PARENT)==dict(zip(KEYS,["536870912","0","1"]))
    active={}
    cleaned=set()
    def cleanup_once(unit,proc,deadline):
        if unit in cleaned:return
        cleaned.add(unit)
        cg=PARENT/(unit+".service")
        # Kill immediately; all optional blocking cleanup spends only this same
        # stage's reserved absolute deadline. Never restart stop in outer finally.
        if cg.exists() and (cg/"cgroup.kill").exists():(cg/"cgroup.kill").write_text("1")
        try:
            remaining=deadline-time.monotonic()-3
            if remaining>0:
                try:subprocess.run(["systemctl","stop",unit+".service"],timeout=min(2,remaining),check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                except subprocess.TimeoutExpired:
                    if cg.exists() and (cg/"cgroup.kill").exists():(cg/"cgroup.kill").write_text("1")
            if proc is not None and proc.poll() is None:
                proc.kill()
                remaining=deadline-time.monotonic()-2
                if remaining>0:
                    try:proc.wait(timeout=min(1,remaining))
                    except subprocess.TimeoutExpired:emit("ADMIN_WAIT_INCOMPLETE",{"unit":unit})
        finally:
            restore()
            active.pop(unit,None)
            if cg.exists():assert dict(line.split() for line in (cg/"cgroup.events").read_text().splitlines())["populated"]=="0"
            actual_remaining=deadline-time.monotonic()
            emit("SERVICE_CLEANUP_ONCE",{"unit":unit,"deadline_remaining":actual_remaining,"limits":gate(PARENT)})
            assert actual_remaining>=0,"service cleanup exceeded its absolute deadline"
    def run(stage,unit,limit,deadline):
        remaining=deadline-time.monotonic()
        assert remaining>10,"no launch budget including cleanup reserve"
        runtime=max(1,math.floor(remaining-8))
        # Root wrapper is administrative only. Activation can reset parent oom.group;
        # repair and verify BEFORE irreversible uid/gid drop and Subject exec.
        wrapper=r"""
import json,os,sys,time
from pathlib import Path
controller,stage,base,target,uid,gid,limit,deadline=sys.argv[1:]
uid=int(uid);gid=int(gid);limit=int(limit);deadline=float(deadline)
assert os.geteuid()==0 and uid!=0 and time.monotonic()<deadline-8
line=Path('/proc/self/cgroup').read_text().strip();assert line.startswith('0::/') and '\n' not in line
cg=Path('/sys/fs/cgroup')/line[3:].lstrip('/')
parent=Path('/sys/fs/cgroup/xiongbaowork.slice');assert cg.parent==parent
keys=('memory.max','memory.swap.max','memory.oom.group')
assert {n:(cg/n).read_text().strip() for n in keys}==dict(zip(keys,[str(limit),'0','1']))
(parent/'memory.oom.group').write_text('1')
assert {n:(parent/n).read_text().strip() for n in keys}==dict(zip(keys,['536870912','0','1']))
os.setgroups([]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
assert os.geteuid()==uid and os.getresuid()==(uid,uid,uid) and os.getresgid()==(gid,gid,gid)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':base+'/private-home','CI':'true','NO_COLOR':'1','DO_NOT_TRACK':'1','PYTHONDONTWRITEBYTECODE':'1'}
os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B',controller,'stage',stage,base,target,str(deadline)],env)
"""
        args=["systemd-run","--unit="+unit,"--wait","--pipe","--slice=xiongbaowork.slice","--property=Type=exec","--property=MemoryMax="+str(limit),"--property=MemorySwapMax=0","--property=OOMPolicy=kill","--property=KillMode=control-group","--property=RuntimeMaxSec="+str(runtime),"--property=TimeoutStartSec=2","--property=TimeoutStopSec=2","--property=SendSIGKILL=yes","--working-directory="+str(base),"/usr/bin/python3","-I","-B","-c",wrapper,str(controller),stage,str(base),target,str(uid),str(gid),str(limit),str(deadline)]
        proc=None
        active[unit]=(None,deadline)
        try:
            proc=subprocess.Popen(args,env={"PATH":"/usr/bin:/bin"})
            active[unit]=(proc,deadline)
            proc.wait(timeout=max(1,deadline-time.monotonic()-8))
            return proc.returncode
        except subprocess.TimeoutExpired:
            return 124
        finally:
            cleanup_once(unit,proc,deadline)
    try:
        restore()
        deadline=time.monotonic()+480
        for stage,unit in [("source",UNITS[0]),("copy",UNITS[1]),("deps",UNITS[2])]:
            code=run(stage,unit,67108864,deadline)
            emit("STAGE_TERMINAL",{"stage":stage,"exit":code,"deadline_remaining":deadline-time.monotonic()})
            if code:raise RuntimeError("preparation failed: "+stage)
        generated=run("generate",UNITS[3],536870912,time.monotonic()+120)
        emit("GENERATION_SERVICE_TERMINAL",{"exit":generated})
        exported=run("export",UNITS[4],67108864,time.monotonic()+120)
        if generated or exported:raise RuntimeError("generator or export incomplete")
    finally:
        for unit,(proc,deadline) in list(active.items()):cleanup_once(unit,proc,deadline)
        restore()
        if PARENT.exists():
            populated=dict(line.split() for line in (PARENT/"cgroup.events").read_text().splitlines())["populated"]
            assert populated=="0"
            emit("PROJECT_LIMIT_RESTORED",{"limits":gate(PARENT),"populated":populated})

def main():
    mode=sys.argv[1]
    if mode=="admin":
        base=Path(sys.argv[2]).resolve();target=sys.argv[3];uid=int(sys.argv[4]);gid=int(sys.argv[5])
        assert len(target)==40 and all(c in "0123456789abcdef" for c in target)
        admin_run(base,target,uid,gid);return
    assert mode=="stage" and os.geteuid()!=0
    stage=sys.argv[2];base=Path(sys.argv[3]).resolve();target=sys.argv[4];deadline=float(sys.argv[5])
    assert time.monotonic()<deadline-8 and Path.cwd()==base
    global CLEAN
    home=base/"private-home";home.mkdir(mode=0o700,exist_ok=True)
    CLEAN={"PATH":os.environ["PATH"],"HOME":str(home),"CI":"true","NO_COLOR":"1","DO_NOT_TRACK":"1"}
    assert "DATABASE_URL" not in os.environ and "GITHUB_TOKEN" not in os.environ and "NODE_OPTIONS" not in os.environ
    if stage=="source":
        own_gate(67108864)
        sys.argv=[str(__file__),target];exec(compile(SOURCE_SCRIPT,"frozen_source_verifier","exec"),{"__name__":"__main__"})
    elif stage=="copy":prepare_copy(base,target)
    elif stage=="deps":prepare_dependencies(base,deadline)
    elif stage=="generate":sys.exit(generate(base,deadline))
    elif stage=="export":sys.exit(export_data(base))
    else:raise AssertionError("unknown stage")
if __name__=="__main__":main()
