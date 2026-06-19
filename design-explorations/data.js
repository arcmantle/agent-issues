// Shared demo dataset for the agent-issues design explorations.
// Mirrors the shape of the live snapshot (projects -> initiatives -> prds/stories/adrs/issues)
// using realistic titles drawn from the Content Hub demo seed.

window.AGENT_ISSUES_DATA = {
	projects: [
		{
			id: "content-hub-demo",
			name: "Content Hub Demo",
			description: "Eyeshare Content Hub — icon libraries, semantic review and administration.",
			updatedAt: "2026-06-09",
			adrs: [
				{ id: "ADR1", title: "ADR 004 Semantic Review Snapshots", status: "accepted", updatedAt: "2026-06-09", initiative: "INIT2" },
				{ id: "ADR2", title: "ADR 005 Server Owned Review Read Model", status: "accepted", updatedAt: "2026-06-09", initiative: "INIT2" }
			],
			initiatives: [
				{
					id: "INIT1",
					title: "Icon Libraries",
					status: "active",
					summary: "Managed, versioned icon library asset containers with source-backed imports and semantic versioning.",
					prds: [{ id: "PRD1", title: "Icon Libraries PRD", status: "approved" }],
					adrs: [],
					stories: [
						{ id: "US1", title: "Create a Managed Asset Container of the Icon Library type", status: "done" },
						{ id: "US10", title: "Suggest an Icon Library Version from the detected icon diff", status: "done" },
						{ id: "US11", title: "Override the suggested Icon Library Version during review or promotion", status: "done" },
						{ id: "US12", title: "Import an Icon Library from a source repository", status: "ready" },
						{ id: "US13", title: "Resolve collision overrides during source remap carry-forward", status: "ready" }
					],
					issues: [
						{ id: "ISS1", title: "01 Managed Icon Library Shell With Empty Sprite Asset", status: "done", story: "US1" },
						{ id: "ISS2", title: "02 First Editable Icon Library Publish", status: "done", story: "US1" },
						{ id: "ISS3", title: "03 Exact Version Icon Asset Resolution", status: "done", story: "US10" },
						{ id: "ISS4", title: "04 Stable Semver Selector Resolution", status: "done", story: "US10" },
						{ id: "ISS5", title: "05 Breaking Revisions And Prerelease Promotion", status: "done", story: "US11" },
						{ id: "ISS6", title: "06 First Source-backed Icon Library Import", status: "done", story: "US12" },
						{ id: "ISS7", title: "07 Collision Overrides And Source Remap Carry-forward", status: "todo", story: "US13" }
					]
				},
				{
					id: "INIT2",
					title: "Semantic Review",
					status: "active",
					summary: "Server-owned review snapshots over saved target files with context-aware, coalesced review runs.",
					prds: [{ id: "PRD2", title: "Semantic Review PRD", status: "approved" }],
					adrs: [
						{ id: "ADR1", title: "ADR 004 Semantic Review Snapshots", status: "accepted" },
						{ id: "ADR2", title: "ADR 005 Server Owned Review Read Model", status: "accepted" }
					],
					stories: [
						{ id: "US40", title: "See live review checks in the shared read model", status: "done" },
						{ id: "US41", title: "Run a first semantic review for saved target files", status: "done" },
						{ id: "US42", title: "Detect a stale latest snapshot for changed targets", status: "ready" },
						{ id: "US43", title: "Review across variants and one-hop links", status: "ready" },
						{ id: "US44", title: "Provision ReviewConfig in deployed environments", status: "blocked" }
					],
					issues: [
						{ id: "ISS8", title: "01 Review Surface With No Snapshot State", status: "done", story: "US40" },
						{ id: "ISS9", title: "02 Live Review Checks In The Shared Read Model", status: "done", story: "US40" },
						{ id: "ISS10", title: "03 First Semantic Review Run For Saved Target Files", status: "done", story: "US41" },
						{ id: "ISS11", title: "04 Stale Latest Snapshot For Changed Targets", status: "done", story: "US42" },
						{ id: "ISS12", title: "05 Context Aware Review Across Variants And One Hop Links", status: "done", story: "US43" },
						{ id: "ISS13", title: "06 Coalesced Runs And Hardened Failure Semantics", status: "done", story: "US43" },
						{ id: "ISS14", title: "07 Provision ReviewConfig In Deployed Environments", status: "blocked", story: "US44" }
					]
				},
				{
					id: "INIT3",
					title: "Semantic Review Copilot CLI Integration",
					status: "draft",
					summary: "Wire the Copilot CLI into Semantic Review with readiness contracts, prompt budgets and diagnostics.",
					prds: [{ id: "PRD3", title: "Semantic Review Copilot CLI Integration PRD", status: "approved" }],
					adrs: [],
					stories: [
						{ id: "US100", title: "Fixed global execution capacity for the Semantic Review subsystem", status: "ready" },
						{ id: "US101", title: "Last successful Review Snapshot survives operational failures", status: "ready" },
						{ id: "US102", title: "Preserve server-owned seams for Semantic Review", status: "ready" }
					],
					issues: [
						{ id: "ISS15", title: "01 Disabled-aware ReviewConfig Activation In Review Surfaces", status: "todo", story: "US100" },
						{ id: "ISS16", title: "02 First Successful Copilot CLI Review Run", status: "todo", story: "US100" },
						{ id: "ISS17", title: "03 Startup Validation And Anonymous Readiness Contract", status: "todo", story: "US101" },
						{ id: "ISS18", title: "04 Admin-triggered Diagnostics And Current Runtime Posture", status: "todo", story: "US102" },
						{ id: "ISS19", title: "05 Prompt Budget And Typed Rejection Semantics", status: "todo", story: "US102" },
						{ id: "ISS20", title: "06 Fixed Execution Capacity And Busy Result", status: "todo", story: "US100" },
						{ id: "ISS21", title: "07 Deployed Copilot CLI Provisioning And Operator Runbook", status: "todo", story: "US101" }
					]
				},
				{
					id: "INIT4",
					title: "Settings And Administration",
					status: "draft",
					summary: "Route-backed settings panel and an administration workbench with access, integrations and diagnostics.",
					prds: [{ id: "PRD4", title: "Settings And Administration PRD", status: "approved" }],
					adrs: [],
					stories: [
						{ id: "US103", title: "Open Settings from a profile affordance instead of the main rail", status: "ready" },
						{ id: "US106", title: "Settings opens as a route-backed panel", status: "ready" },
						{ id: "US112", title: "Theme has one canonical home in Settings", status: "ready" },
						{ id: "US115", title: "Theme supports Light, Dark and System", status: "ready" }
					],
					issues: [
						{ id: "ISS22", title: "01 Profile Affordance With Session Summary", status: "todo", story: "US103" },
						{ id: "ISS23", title: "02 Route-backed Settings Panel With Three-state Theme Preference", status: "todo", story: "US106" },
						{ id: "ISS24", title: "03 Administration Workbench Shell And Overview", status: "todo", story: "US112" },
						{ id: "ISS25", title: "04 Access Module Read Surface", status: "todo", story: "US112" },
						{ id: "ISS26", title: "05 Integrations Module With Semantic Review Diagnostics", status: "todo", story: "US115" },
						{ id: "ISS27", title: "06 Escalated Domain Signals In Administration Overview", status: "todo", story: "US115" }
					]
				}
			]
		},
		{
			id: "platform-core",
			name: "Platform Core",
			description: "Shared identity, billing and observability platform for the product suite.",
			updatedAt: "2026-06-05",
			adrs: [
				{ id: "ADR1", title: "ADR 001 Token-based Session Model", status: "accepted", updatedAt: "2026-05-30", initiative: "INIT1" },
				{ id: "ADR2", title: "ADR 002 Usage-metered Billing Events", status: "proposed", updatedAt: "2026-06-04", initiative: "INIT2" }
			],
			initiatives: [
				{
					id: "INIT1",
					title: "Auth & Identity",
					status: "active",
					summary: "Unified sign-in, session tokens and tenant-scoped authorization across the suite.",
					prds: [{ id: "PRD1", title: "Auth & Identity PRD", status: "approved" }],
					adrs: [{ id: "ADR1", title: "ADR 001 Token-based Session Model", status: "accepted" }],
					stories: [
						{ id: "US1", title: "Sign in with a single shared identity provider", status: "done" },
						{ id: "US2", title: "Scope authorization to the active tenant", status: "ready" },
						{ id: "US3", title: "Rotate session tokens without forcing re-login", status: "ready" }
					],
					issues: [
						{ id: "ISS1", title: "01 Shared Sign-in Shell", status: "done", story: "US1" },
						{ id: "ISS2", title: "02 Tenant-scoped Authorization Claims", status: "todo", story: "US2" },
						{ id: "ISS3", title: "03 Silent Token Rotation", status: "todo", story: "US3" }
					]
				},
				{
					id: "INIT2",
					title: "Billing",
					status: "draft",
					summary: "Usage-metered billing events, invoices and a self-serve plan management surface.",
					prds: [{ id: "PRD2", title: "Billing PRD", status: "draft" }],
					adrs: [{ id: "ADR2", title: "ADR 002 Usage-metered Billing Events", status: "proposed" }],
					stories: [
						{ id: "US10", title: "Emit a metered usage event per billable action", status: "ready" },
						{ id: "US11", title: "Generate a monthly invoice from usage events", status: "ready" }
					],
					issues: [
						{ id: "ISS10", title: "01 Usage Event Pipeline Skeleton", status: "todo", story: "US10" },
						{ id: "ISS11", title: "02 Invoice Aggregation Job", status: "blocked", story: "US11" }
					]
				}
			]
		}
	]
};
