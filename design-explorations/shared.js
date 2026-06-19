// Shared helpers for the agent-issues design explorations:
//  - AIShared.badge(status)             -> status pill markup
//  - AIShared.detail(entity, kind, init)-> structured detail object
//  - AIShared.detailHTML(detail)        -> detail panel markup (generic ai-* classes)
//  - AIShared.buildInitiativeGraph(init)
//  - AIShared.buildProjectGraph(project)
//  - AIShared.renderGraph(hostEl, graph, onClick)
// Detail bodies are generated prototype-quality copy so every record shows something.

(function () {
	const TONE = {
		active: "green", draft: "gray", done: "purple", todo: "gray",
		ready: "blue", blocked: "red", accepted: "green", approved: "green", proposed: "yellow"
	};

	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
	const badge = (status) => `<span class="badge ${TONE[status] || "gray"}">${esc(status)}</span>`;

	const issuesForStory = (init, storyId) => init.issues.filter((i) => i.story === storyId);
	const storyForIssue = (init, issue) => init.stories.find((s) => s.id === issue.story);
	const ref = (e, kind, initId) => ({ id: e.id, title: e.title, status: e.status, kind, initId });

	function detail(entity, kind, init) {
		if (kind === "prd") {
			return {
				kind, id: entity.id, title: entity.title, status: entity.status,
				meta: [["Initiative", init.title], ["Linked stories", String(init.stories.length)], ["Linked issues", String(init.issues.length)]],
				sections: [
					{ title: "Summary", body: `<p>${esc(entity.title)} captures the product requirements for the <b>${esc(init.title)}</b> initiative. ${esc(init.summary)}</p>` },
					{ title: "Goals", list: [
						`Deliver ${init.title.toLowerCase()} as described in the initiative summary.`,
						"Keep scope aligned with the linked user stories below.",
						`Track delivery through the ${init.issues.length} associated issues.`
					] },
					{ title: "Linked user stories", refs: init.stories.map((s) => ref(s, "story", init.id)) }
				]
			};
		}
		if (kind === "adr") {
			return {
				kind, id: entity.id, title: entity.title, status: entity.status,
				meta: [["Initiative", init.title], ["Decision status", entity.status], ["Updated", entity.updatedAt || "—"]],
				sections: [
					{ title: "Context", body: `<p>Within <b>${esc(init.title)}</b>, ${esc(init.summary)} This record — ${esc(entity.title)} — captures the architectural choice that shaped that work.</p>` },
					{ title: "Decision", body: `<p>We adopt the approach described by <b>${esc(entity.title)}</b>. The decision is currently <b>${esc(entity.status)}</b>.</p>` },
					{ title: "Consequences", list: [
						"Establishes a server-owned seam that downstream issues build on.",
						"Constrains future changes to remain compatible with this decision.",
						"Recorded so the rationale survives beyond the original authors."
					] }
				]
			};
		}
		if (kind === "story") {
			const issues = issuesForStory(init, entity.id);
			return {
				kind, id: entity.id, title: entity.title, status: entity.status,
				meta: [["Initiative", init.title], ["Status", entity.status], ["Linked issues", String(issues.length)]],
				sections: [
					{ title: "Narrative", body: `<p><b>As a</b> product stakeholder, <b>I want</b> ${esc(entity.title.toLowerCase())}, <b>so that</b> the ${esc(init.title)} initiative delivers its intended value.</p>` },
					{ title: "Acceptance criteria", list: [
						`The behaviour described by “${entity.title}” is observable in the product.`,
						`The ${issues.length} linked issue${issues.length === 1 ? "" : "s"} are completed and verified.`,
						`No regressions are introduced elsewhere in ${init.title}.`
					] },
					{ title: "Implementing issues", refs: issues.map((i) => ref(i, "issue", init.id)) }
				]
			};
		}
		// issue
		const story = storyForIssue(init, entity);
		const sections = [
			{ title: "Description", body: `<p>${esc(entity.title)} is a delivery slice of the ${esc(init.title)} initiative${story ? `, implementing user story <b>${esc(story.id)}</b> — ${esc(story.title)}` : ""}.</p>` },
			{ title: "Tasks", list: [
				`Implement: ${entity.title}.`,
				"Add or update tests covering the change.",
				"Verify against the acceptance criteria of the parent story."
			] }
		];
		if (story) {
			sections.push({ title: "Parent user story", refs: [ref(story, "story", init.id)] });
		}
		return {
			kind, id: entity.id, title: entity.title, status: entity.status,
			meta: [["Initiative", init.title], ["Implements", story ? story.id : "—"], ["Status", entity.status]],
			sections
		};
	}

	const KIND_LABEL = { prd: "PRD", adr: "Architecture decision", story: "User story", issue: "Issue", initiative: "Initiative" };

	function sectionHTML(sec) {
		let inner = "";
		if (sec.body) {
			inner = sec.body;
		} else if (sec.list) {
			inner = `<ul class="ai-list">${sec.list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>`;
		} else if (sec.refs) {
			inner = sec.refs.length
				? `<div class="ai-refs">${sec.refs.map((r) => `
					<button class="ai-ref" data-open="${r.kind}:${r.id}" data-init="${r.initId}">
						<span class="r-id">${esc(r.id)}</span>
						<span class="r-title">${esc(r.title)}</span>
						${badge(r.status)}
					</button>`).join("")}</div>`
				: `<div class="ai-empty">Nothing linked yet.</div>`;
		}
		return `<section class="ai-sec"><h2>${esc(sec.title)}</h2>${inner}</section>`;
	}

	function detailHTML(d) {
		return `
			<div class="ai-kind">${esc(KIND_LABEL[d.kind] || d.kind)}</div>
			<h1 class="ai-d-title">${esc(d.title)} ${badge(d.status)} <span class="ai-id">${esc(d.id)}</span></h1>
			<div class="ai-meta">${d.meta.map(([k, v]) => `<div class="m"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
			${d.sections.map(sectionHTML).join("")}
		`;
	}

	/* ---------------- Graph ---------------- */
	function buildInitiativeGraph(init) {
		const nodes = [];
		const edges = [];
		nodes.push({ key: init.id, label: init.title, fullLabel: init.title, kind: "initiative", col: 0, ref: { id: init.id, initId: init.id } });
		init.prds.forEach((p) => { nodes.push({ key: p.id, label: p.title, fullLabel: p.title, kind: "prd", col: 1, ref: { id: p.id, initId: init.id } }); edges.push({ from: init.id, to: p.id }); });
		init.adrs.forEach((a) => { nodes.push({ key: a.id, label: a.title, fullLabel: a.title, kind: "adr", col: 1, ref: { id: a.id, initId: init.id } }); edges.push({ from: init.id, to: a.id }); });
		init.stories.forEach((s) => { nodes.push({ key: s.id, label: s.title, fullLabel: s.title, kind: "story", col: 2, ref: { id: s.id, initId: init.id } }); edges.push({ from: init.id, to: s.id }); });
		// issues grouped by story so edges stay readable
		const seen = new Set();
		init.stories.forEach((s) => {
			issuesForStory(init, s.id).forEach((i) => {
				seen.add(i.id);
				nodes.push({ key: i.id, label: i.title, fullLabel: i.title, kind: "issue", status: i.status, col: 3, ref: { id: i.id, initId: init.id } });
				edges.push({ from: s.id, to: i.id });
			});
		});
		init.issues.filter((i) => !seen.has(i.id)).forEach((i) => {
			nodes.push({ key: i.id, label: i.title, fullLabel: i.title, kind: "issue", status: i.status, col: 3, ref: { id: i.id, initId: init.id } });
			edges.push({ from: init.id, to: i.id });
		});
		return { columns: ["Initiative", "PRDs & ADRs", "User stories", "Issues"], nodes, edges };
	}

	function buildProjectGraph(project) {
		const nodes = [{ key: "__project", label: project.name, fullLabel: project.description, kind: "project", col: 0, ref: { id: "", initId: "" } }];
		const edges = [];
		project.initiatives.forEach((init) => {
			const label = `${init.title}`;
			nodes.push({ key: init.id, label, fullLabel: `${init.title} — ${init.stories.length} stories, ${init.issues.length} issues`, kind: "initiative", col: 1, ref: { id: init.id, initId: init.id } });
			edges.push({ from: "__project", to: init.id });
			[...init.prds.map((p) => ["prd", p]), ...init.adrs.map((a) => ["adr", a])].forEach(([kind, e]) => {
				const key = `${init.id}:${e.id}`;
				nodes.push({ key, label: e.title, fullLabel: e.title, kind, col: 2, ref: { id: e.id, initId: init.id } });
				edges.push({ from: init.id, to: key });
			});
		});
		return { columns: ["Project", "Initiatives", "PRDs & ADRs"], nodes, edges };
	}

	const KIND_COLOR = { project: "#24292f", initiative: "#0969da", prd: "#1f883d", adr: "#8250df", story: "#bf8700", issue: "#0a7ea4" };
	const STATUS_STROKE = { done: "#8250df", blocked: "#cf222e" };

	function renderGraph(host, graph, onClick) {
		const cols = {};
		graph.nodes.forEach((n) => { (cols[n.col] = cols[n.col] || []).push(n); });
		const colIdx = Object.keys(cols).map(Number).sort((a, b) => a - b);
		const columns = Math.max(...graph.nodes.map((n) => n.col)) + 1;
		const nodeW = 184, nodeH = 34, colGap = 244, padX = 28, padTop = 56, rowH = 58;
		const maxCount = Math.max(...colIdx.map((c) => cols[c].length));
		const width = padX * 2 + (columns - 1) * colGap + nodeW;
		const height = padTop + maxCount * rowH + 24;

		const pos = {};
		colIdx.forEach((c) => {
			cols[c].forEach((n, i) => {
				const x = padX + c * colGap;
				const y = padTop + i * rowH;
				pos[n.key] = { x, y, cx: x + nodeW / 2, cy: y + nodeH / 2 };
			});
		});

		let heads = "";
		(graph.columns || []).forEach((t, c) => {
			if (!cols[c]) return;
			heads += `<text class="ai-colhead" x="${padX + c * colGap + nodeW / 2}" y="28" text-anchor="middle">${esc(t)}</text>`;
		});

		let edges = "";
		graph.edges.forEach((e) => {
			const a = pos[e.from], b = pos[e.to];
			if (!a || !b) return;
			const x1 = a.cx + nodeW / 2, y1 = a.cy, x2 = b.cx - nodeW / 2, y2 = b.cy;
			edges += `<path class="ai-edge" d="M${x1} ${y1} C ${x1 + 46} ${y1}, ${x2 - 46} ${y2}, ${x2} ${y2}" fill="none" stroke="#d0d7de" stroke-width="1.5"/>`;
		});

		let nodesSvg = "";
		graph.nodes.forEach((n) => {
			const p = pos[n.key];
			const color = KIND_COLOR[n.kind] || "#59636e";
			const stroke = (n.kind === "issue" && STATUS_STROKE[n.status]) ? STATUS_STROKE[n.status] : color;
			const clickable = n.kind !== "project";
			nodesSvg += `<g class="ai-node${clickable ? "" : " ai-node-static"}" data-key="${n.key}" data-id="${esc(n.ref ? n.ref.id : "")}" data-kind="${n.kind}" data-init="${esc(n.ref ? n.ref.initId : "")}" style="cursor:${clickable ? "pointer" : "default"}">
				<title>${esc(n.fullLabel || n.label)}</title>
				<rect class="ai-node-rect" x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="9" fill="#fff" stroke="${stroke}" stroke-width="1.5"/>
				<circle cx="${p.x + 15}" cy="${p.cy}" r="5" fill="${color}"/>
				<text class="ai-node-label" x="${p.x + 28}" y="${p.cy + 4}">${esc(trunc(n.label, 21))}</text>
			</g>`;
		});

		host.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="display:block">${heads}${edges}${nodesSvg}</svg>`;
		host.querySelectorAll(".ai-node").forEach((g) => {
			if (g.classList.contains("ai-node-static")) return;
			g.addEventListener("click", () => onClick && onClick({ id: g.dataset.id, kind: g.dataset.kind, initId: g.dataset.init }));
		});
	}

	window.AIShared = { badge, detail, detailHTML, buildInitiativeGraph, buildProjectGraph, renderGraph };
})();
