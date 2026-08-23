	import "./kanban-empty-state-draft.js";
	import "./kanban-no-results-state-draft.js";
	import "./kanban-error-state-draft.js";
	import "./kanban-activity-event-draft.js";
	import "./kanban-activity-timeline-draft.js";
	import "./kanban-popover-menu-draft.js";
import "./kanban-sidebar-draft.js";
import "./kanban-navigation-tree-draft.js";
import "./kanban-mobile-navigation-drawer-draft.js";
import "./kanban-app-shell-draft.js";
import "./kanban-header-draft.js";
import "./kanban-breadcrumb-trail-draft.js";
import "./kanban-tabs-draft.js";
import "./kanban-board-draft.js";
import "./kanban-column-draft.js";
import "./kanban-column-header-draft.js";
import "./kanban-card-draft.js";
import "./kanban-card-metadata-draft.js";
import "./kanban-status-badge-draft.js";
import "./kanban-graph-edge-draft.js";
import "./kanban-graph-node-draft.js";
import "./kanban-relationship-graph-draft.js";
import "./kanban-priority-badge-draft.js";
import "./kanban-field-display-draft.js";
import "./kanban-field-editor-draft.js";
import "./kanban-record-summary-draft.js";
import "./kanban-record-toolbar-draft.js";
import "./kanban-record-detail-panel-draft.js";
import "./kanban-shortcut-hint-draft.js";
import "./kanban-icon-button-draft.js";
import "./kanban-button-draft.js";
import "./kanban-overlay-draft.js";
import "./kanban-issue-overlay-draft.js";
import "./kanban-relationship-item-draft.js";
import "./kanban-relationship-list-draft.js";
import "./kanban-comment-item-draft.js";
import "./kanban-comment-composer-draft.js";
import "./kanban-comment-thread-draft.js";
import "./kanban-entity-table-draft.js";
import "./kanban-table-toolbar-draft.js";
import "./kanban-entity-view-draft.js";
import "./kanban-overview-draft.js";
import "./kanban-unsaved-changes-draft.js";
import "./kanban-skeleton-draft.js";
import "./kanban-loading-state-draft.js";
import "./kanban-keyboard-focus-draft.js";
import "./kanban-toast-notification-draft.js";
import "./kanban-confirm-dialog-draft.js";
import "./kanban-empty-state-draft.js";
import "./kanban-no-results-state-draft.js";
import "./kanban-error-state-draft.js";
import "./kanban-activity-event-draft.js";
import "./kanban-activity-timeline-draft.js";
import "./kanban-select-menu-draft.js";

const draftLabels = {
	overview: "Overview composition",
	appShell: "App shell draft",
	sidebar: "Sidebar draft",
	navigationTree: "Navigation tree draft",
	mobileNavigationDrawer: "Mobile navigation drawer draft",
	header: "Header draft",
	breadcrumbTrail: "Breadcrumb trail draft",
	tabs: "Tab bar draft",
	board: "Kanban board draft",
	column: "Kanban column draft",
	columnHeader: "Kanban column header draft",
	table: "Entity table draft",
	tableToolbar: "Table toolbar draft",
	graphEdge: "Graph edge draft",
	graphNode: "Graph node draft",
	relationshipGraph: "Relationship graph draft",
	card: "Kanban card draft",
	cardMetadata: "Kanban card metadata draft",
	statusBadge: "Status badge draft",
	priorityBadge: "Priority badge draft",
	fieldDisplay: "Field display draft",
	fieldEditor: "Field editor draft",
	recordSummary: "Record summary draft",
	recordToolbar: "Record toolbar draft",
	recordDetailPanel: "Record detail panel draft",
	selectMenu: "Select menu draft",
	shortcutHint: "Shortcut hint draft",
	iconButton: "Icon button draft",
	button: "Button draft",
	popoverMenu: "Popover menu draft",
	relationshipItem: "Relationship item draft",
	relationshipList: "Relationship list draft",
	commentItem: "Comment item draft",
	commentComposer: "Comment composer draft",
	commentThread: "Comment thread draft",
	overlay: "Entity overlay draft",
	issueOverlay: "Issue overlay draft",
	unsavedChanges: "Unsaved changes indicator draft",
	skeleton: "Skeleton draft",
	loadingState: "Loading state draft",
	keyboardFocus: "Keyboard focus treatment draft",
	toast: "Toast notification draft",
	confirmDialog: "Confirm dialog draft",
	emptyState: "Empty state draft",
	noResults: "No-results state draft",
	errorState: "Error state draft",
	activityEvent: "Activity event draft",
	activityTimeline: "Activity timeline draft",
	table: "Entity table draft",
	plans: "Plans view draft",
	prds: "PRDs view draft",
	adrs: "ADRs view draft",
	debt: "Debt view draft",
	graph: "Graph view draft",
	activity: "Activity view draft"
};

function componentPreview(draft, component) {
	return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels[draft]}</h1><p>Use the component rail to inspect each element in isolation. The overview composes the same elements.</p></header><div class="component-stage ${draft}"><${component}></${component}></div></section>`;
}

function draftView(draft) {
	if (draft === "overview") return "<kanban-overview-draft></kanban-overview-draft>";
	if (draft === "sidebar") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.sidebar}</h1><p>Compare expanded and compact states. Both use the same control that changes the overview layout.</p></header><div class="sidebar-state-comparison"><section><h2>Expanded</h2><kanban-sidebar-draft></kanban-sidebar-draft></section><section><h2>Collapsed</h2><kanban-sidebar-draft collapsed></kanban-sidebar-draft></section></div></section>`;
	}
	if (draft === "navigationTree") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.navigationTree}</h1><p>A hierarchy for moving from a project to its epics, initiatives, and records. Expand or collapse a parent to focus the current branch.</p></header><div class="component-stage navigation-tree"><section class="navigation-tree-preview-state"><h2>Project hierarchy</h2><kanban-navigation-tree-draft></kanban-navigation-tree-draft></section><section class="navigation-tree-preview-state"><h2>Empty project</h2><kanban-navigation-tree-draft empty></kanban-navigation-tree-draft></section></div></section>`;
	}
	if (draft === "mobileNavigationDrawer") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.mobileNavigationDrawer}</h1><p>A small-screen navigation surface that opens from the overview header and closes with its scrim, close control, or Escape.</p></header><div class="component-stage mobile-navigation-drawer-preview"><kanban-mobile-navigation-drawer-draft open></kanban-mobile-navigation-drawer-draft></div></section>`;
	}
	if (draft === "breadcrumbTrail") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.breadcrumbTrail}</h1><p>A reusable record path that retains the current location on a narrow screen.</p></header><div class="component-stage breadcrumbTrail"><kanban-breadcrumb-trail-draft items="Agent Issues|Platform foundations|Editable Kanban board"></kanban-breadcrumb-trail-draft></div></section>`;
	}
	if (draft === "overlay") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.overlay}</h1><p>The shared right-side record surface for initiatives and other entities. It is open here for direct review.</p></header><div class="component-stage overlay"><kanban-initiative-overlay open></kanban-initiative-overlay></div></section>`;
	}
	if (draft === "issueOverlay") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.issueOverlay}</h1><p>The record surface that opens from a Kanban card. It exposes issue fields, relationships, comments, and pending record changes.</p></header><div class="component-stage issue-overlay-preview"><kanban-issue-overlay-draft reference="ISS-322" title="Define the board-server write contract" category="High" detail="2 blockers" status="Todo" pending open></kanban-issue-overlay-draft></div></section>`;
	}
	if (draft === "commentItem") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.commentItem}</h1><p>A timestamped author message for use in an issue discussion.</p></header><div class="component-stage comment-item"><kanban-comment-item-draft author="R. Lee" time="Today, 10:24" message="Keep server behavior identical for local and cloud workspaces."></kanban-comment-item-draft></div></section>`;
	}
	if (draft === "relationshipItem") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.relationshipItem}</h1><p>A typed record summary with a relation label and an action to open the related record.</p></header><div class="component-stage relationship-item"><kanban-relationship-item-draft kind="Issue" title="Start detached Kanban server" relation="Blocks"></kanban-relationship-item-draft></div></section>`;
	}
	if (draft === "relationshipList") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.relationshipList}</h1><p>An ordered related-record collection that shows the current relationships or an empty state.</p></header><div class="component-stage relationship-list"><section class="relationship-list-preview-state"><h2>Related records</h2><kanban-relationship-list-draft></kanban-relationship-list-draft></section><section class="relationship-list-preview-state"><h2>Empty state</h2><kanban-relationship-list-draft empty label="Empty relationship list"></kanban-relationship-list-draft></section></div></section>`;
	}
	if (draft === "commentComposer") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.commentComposer}</h1><p>A message field and post command for adding a new comment to an issue discussion.</p></header><div class="component-stage comment-composer"><kanban-comment-composer-draft></kanban-comment-composer-draft></div></section>`;
	}
	if (draft === "commentThread") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.commentThread}</h1><p>An ordered record discussion that shows existing comments or an empty state, then lets a project member add, edit, or delete their own comments.</p></header><div class="component-stage comment-thread"><section class="comment-thread-preview-state"><h2>Your comment</h2><kanban-comment-thread-draft author="You" time="Today, 10:24" message="Keep server behavior identical for local and cloud workspaces." owned></kanban-comment-thread-draft></section><section class="comment-thread-preview-state"><h2>Empty state</h2><kanban-comment-thread-draft empty label="Empty comment thread"></kanban-comment-thread-draft></section></div></section>`;
	}
	if (draft === "unsavedChanges") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.unsavedChanges}</h1><p>The indicator is hidden after a record save and appears while an optimistic record change is pending.</p></header><div class="component-stage unsaved-changes"><section class="unsaved-changes-state"><h2>Saved</h2><p>No pending record changes.</p><kanban-unsaved-changes-draft></kanban-unsaved-changes-draft></section><section class="unsaved-changes-state"><h2>Pending edit</h2><p>A record change is waiting to save.</p><kanban-unsaved-changes-draft pending></kanban-unsaved-changes-draft></section></div></section>`;
	}
	if (draft === "skeleton") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.skeleton}</h1><p>Stable loading placeholders retain the layout of card, table, and record-panel content.</p></header><div class="component-stage skeleton"><section class="skeleton-preview"><h2>Card</h2><kanban-skeleton-draft layout="card"></kanban-skeleton-draft></section><section class="skeleton-preview"><h2>Record panel</h2><kanban-skeleton-draft layout="panel"></kanban-skeleton-draft></section><section class="skeleton-preview is-table"><h2>Table</h2><kanban-skeleton-draft layout="table"></kanban-skeleton-draft></section></div></section>`;
	}
	if (draft === "loadingState") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.loadingState}</h1><p>A stable loading state retains the structure of data views while record data is prepared.</p></header><div class="component-stage loading-state"><kanban-loading-state-draft></kanban-loading-state-draft></div></section>`;
	}
	if (draft === "keyboardFocus") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.keyboardFocus}</h1><p>Keyboard navigation gives each enabled control a consistent, high-contrast focus treatment.</p></header><div class="component-stage keyboard-focus"><kanban-keyboard-focus-draft></kanban-keyboard-focus-draft></div></section>`;
	}
	if (draft === "toast") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.toast}</h1><p>A non-blocking message confirms the result of a record action. Dismiss the notification when it is no longer useful.</p></header><div class="component-stage toast-notification"><kanban-toast-notification-draft tone="success" message="Issue saved"></kanban-toast-notification-draft><kanban-toast-notification-draft tone="warning" message="Some changes need attention"></kanban-toast-notification-draft><kanban-toast-notification-draft tone="failure" message="Could not save changes"></kanban-toast-notification-draft></div></section>`;
	}
	if (draft === "confirmDialog") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.confirmDialog}</h1><p>A focused confirmation prevents irreversible record actions from running by mistake. Cancel, confirm, or press Escape to close it.</p></header><div class="component-stage confirm-dialog"><kanban-confirm-dialog-draft title="Delete issue?" message="This permanently deletes ISS-322 and its comments. This action cannot be undone." confirm-label="Delete issue" open></kanban-confirm-dialog-draft></div></section>`;
	}
	if (draft === "emptyState") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.emptyState}</h1><p>A clear no-record state explains the view and gives the user one appropriate next action.</p></header><div class="component-stage empty-state"><kanban-empty-state-draft heading="No plans yet" message="Create the first delivery plan for this initiative to organize the work." action-label="Create plan"></kanban-empty-state-draft></div></section>`;
	}
	if (draft === "noResults") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.noResults}</h1><p>A filtered-search state explains when no records match the current search and gives the user a direct recovery action.</p></header><div class="component-stage no-results"><kanban-no-results-state-draft query="mobile review"></kanban-no-results-state-draft></div></section>`;
	}
	if (draft === "errorState") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.errorState}</h1><p>A recoverable failure state explains when record data cannot load and gives the user a direct recovery action.</p></header><div class="component-stage error-state"><kanban-error-state-draft></kanban-error-state-draft></div></section>`;
	}
	if (draft === "activityEvent") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.activityEvent}</h1><p>A timestamped record change for use in an activity timeline.</p></header><div class="component-stage activity-event"><kanban-activity-event-draft time="Today, 10:24" summary="R. Lee moved ISS-318 to In progress" detail="Keep pending edits stable through snapshot refresh" tone="accent"></kanban-activity-event-draft></div></section>`;
	}
	if (draft === "activityTimeline") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.activityTimeline}</h1><p>A chronological activity container that composes timestamped record changes and shows an empty state when no activity is available.</p></header><div class="component-stage activity-timeline"><section class="activity-timeline-preview-state"><h2>Recent activity</h2><kanban-activity-timeline-draft></kanban-activity-timeline-draft></section><section class="activity-timeline-preview-state"><h2>Empty state</h2><kanban-activity-timeline-draft empty label="Empty initiative activity"></kanban-activity-timeline-draft></section></div></section>`;
	}
	if (draft === "column") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.column}</h1><p>A status header plus a default slot for cards. The board composes four of these components.</p></header><div class="component-stage column"><kanban-column-draft title="Todo" count="02"><kanban-card-draft reference="ISS-322" title="Define the board-server write contract" category="High" detail="2 blockers" blockers="2" relationships="3"></kanban-card-draft><kanban-card-draft reference="ISS-327" title="Render a compact issue card" category="Product" detail="PRD 26" relationships="1"></kanban-card-draft></kanban-column-draft></div></section>`;
	}
	if (draft === "columnHeader") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.columnHeader}</h1><p>A status title, record count, and focused actions for one Kanban column.</p></header><div class="component-stage column-header"><kanban-column-header-draft title="In progress" count="02"></kanban-column-header-draft></div></section>`;
	}
	if (draft === "card") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.card}</h1><p>A compact issue record for use inside a Kanban column.</p></header><div class="component-stage card"><kanban-card-draft reference="ISS-322" title="Define the board-server write contract" category="High" detail="2 blockers" blockers="2" relationships="3"></kanban-card-draft></div></section>`;
	}
	if (draft === "cardMetadata") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.cardMetadata}</h1><p>Portable record details for a Kanban card, including its badges, owner, due state, blockers, and relationship count.</p></header><div class="component-stage card-metadata"><section><h2>Current</h2><kanban-card-metadata-draft reference="ISS-322" status="Todo" priority="High" owner="R. Lee" due="Today" blockers="0" relationships="2"></kanban-card-metadata-draft></section><section><h2>Blocked</h2><kanban-card-metadata-draft reference="ISS-319" status="Blocked" priority="High" owner="Unassigned" due="Overdue" blockers="1" relationships="4"></kanban-card-metadata-draft></section></div></section>`;
	}
	if (draft === "statusBadge") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.statusBadge}</h1><p>A consistent status label for cards, tables, and record detail.</p></header><div class="component-stage status-badge"><kanban-status-badge-draft status="Todo"></kanban-status-badge-draft><kanban-status-badge-draft status="In progress"></kanban-status-badge-draft><kanban-status-badge-draft status="Blocked"></kanban-status-badge-draft><kanban-status-badge-draft status="Done"></kanban-status-badge-draft><kanban-status-badge-draft status="Draft"></kanban-status-badge-draft></div></section>`;
	}
	if (draft === "priorityBadge") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.priorityBadge}</h1><p>A consistent priority label for cards, tables, and record detail.</p></header><div class="component-stage priority-badge"><kanban-priority-badge-draft priority="High"></kanban-priority-badge-draft><kanban-priority-badge-draft priority="Medium"></kanban-priority-badge-draft><kanban-priority-badge-draft priority="Low"></kanban-priority-badge-draft></div></section>`;
	}
	if (draft === "fieldDisplay") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.fieldDisplay}</h1><p>A read-only record field for compact values and longer descriptions.</p></header><div class="component-stage field-display"><kanban-field-display-draft label="Title" value="Define the board-server write contract"></kanban-field-display-draft><kanban-field-display-draft label="Description" value="Apply issue updates and relationship changes through the active storage driver." multiline></kanban-field-display-draft></div></section>`;
	}
	if (draft === "fieldEditor") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.fieldEditor}</h1><p>Editable text, status, and description fields retain native form behavior for record changes.</p></header><div class="component-stage field-editor"><kanban-field-editor-draft label="Title" name="title" value="Define the board-server write contract"></kanban-field-editor-draft><kanban-field-editor-draft label="Status" name="status" type="select" value="Todo" options="Todo|In progress|Blocked|Done"></kanban-field-editor-draft><kanban-field-editor-draft label="Description" name="description" type="description" value="Apply issue updates and relationship changes through the active storage driver."></kanban-field-editor-draft></div></section>`;
	}
	if (draft === "recordSummary") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.recordSummary}</h1><p>A compact record identity with its reference, key metadata, and current owner.</p></header><div class="component-stage record-summary"><kanban-record-summary-draft reference="ISS-322" title="Define the board-server write contract" metadata="Issue · 2 blockers" owner="R. Lee"></kanban-record-summary-draft></div></section>`;
	}
	if (draft === "recordToolbar") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.recordToolbar}</h1><p>A record title and command surface for record details, issue creation, search, filtering, and switching between board and table views.</p></header><div class="component-stage record-toolbar"><kanban-record-toolbar-draft reference="INIT-05" title="Editable Kanban board"></kanban-record-toolbar-draft></div></section>`;
	}
	if (draft === "recordDetailPanel") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.recordDetailPanel}</h1><p>A shared right-side container for record fields, metadata, and related content. Select the scrim or press Escape to close it.</p></header><div class="component-stage record-detail-panel-preview"><kanban-record-detail-panel-draft label="Issue details" open><div data-record-detail-panel-header class="record-detail-panel-preview-header"><span>Issue record</span><h2>Define the board-server write contract</h2></div><div data-record-detail-panel-meta class="record-detail-panel-preview-meta"><span>Todo</span><span>High priority</span><span>ISS-322</span></div><div data-record-detail-panel-content class="record-detail-panel-preview-content"><h3>Purpose</h3><p>Define the server-facing write boundary that applies issue updates and relationship changes through the active storage driver.</p></div></kanban-record-detail-panel-draft></div></section>`;
	}
	if (draft === "selectMenu") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.selectMenu}</h1><p>A labeled status selector that uses native keyboard and assistive-technology behavior.</p></header><div class="component-stage select-menu"><kanban-select-menu-draft label="Status" name="status" value="Todo" options="Todo|In progress|Blocked|Done"></kanban-select-menu-draft></div></section>`;
	}
	if (draft === "shortcutHint") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.shortcutHint}</h1><p>Compact keyboard labels for commands that have an assigned shortcut.</p></header><div class="component-stage shortcut-hint"><kanban-shortcut-hint-draft keys="C"></kanban-shortcut-hint-draft><kanban-shortcut-hint-draft keys="Cmd+K"></kanban-shortcut-hint-draft><kanban-shortcut-hint-draft keys="Shift+Enter"></kanban-shortcut-hint-draft></div></section>`;
	}
	if (draft === "iconButton") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.iconButton}</h1><p>Compact accessible actions for close, create, collapse, and overflow commands.</p></header><div class="component-stage icon-button"><div class="icon-button-state"><span>Actions</span><div><kanban-icon-button-draft action="close" label="Close issue details"></kanban-icon-button-draft><kanban-icon-button-draft action="create" label="Create issue"></kanban-icon-button-draft><kanban-icon-button-draft action="collapse" label="Collapse sidebar"></kanban-icon-button-draft><kanban-icon-button-draft action="overflow" label="More actions"></kanban-icon-button-draft></div></div><div class="icon-button-state"><span>Unavailable</span><div><kanban-icon-button-draft action="create" label="Create issue" disabled></kanban-icon-button-draft><kanban-icon-button-draft action="overflow" label="Loading actions" loading></kanban-icon-button-draft></div></div></div></section>`;
	}
	if (draft === "button") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.button}</h1><p>Command controls for primary, secondary, quiet, destructive, and loading actions.</p></header><div class="component-stage button"><div class="button-state"><span>Commands</span><div><kanban-button-draft label="Create issue"></kanban-button-draft><kanban-button-draft label="View details" variant="secondary"></kanban-button-draft><kanban-button-draft label="Cancel" variant="quiet"></kanban-button-draft><kanban-button-draft label="Delete issue" variant="destructive"></kanban-button-draft></div></div><div class="button-state"><span>Loading</span><div><kanban-button-draft label="Save changes" loading></kanban-button-draft><kanban-button-draft label="Archive issue" variant="destructive" disabled></kanban-button-draft></div></div></div></section>`;
	}
	if (draft === "popoverMenu") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.popoverMenu}</h1><p>An anchored action menu for contextual record commands. Select a command or press Escape to close it.</p></header><div class="component-stage popover-menu"><kanban-popover-menu-draft label="Issue actions"></kanban-popover-menu-draft></div></section>`;
	}
	if (draft === "table") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.table}</h1><p>A shared semantic table for record lists. It varies columns and rows by entity type.</p></header><div class="component-stage entity-view-stage"><kanban-entity-table-draft view="plans"></kanban-entity-table-draft><section class="entity-table-state-preview"><h2>Loading</h2><kanban-entity-table-draft view="plans" loading></kanban-entity-table-draft></section><section class="entity-table-state-preview"><h2>Empty</h2><kanban-entity-table-draft view="plans" empty></kanban-entity-table-draft></section><section class="entity-table-state-preview"><h2>No results</h2><kanban-entity-table-draft view="plans" no-results query="weekly review"></kanban-entity-table-draft></section><section class="entity-table-state-preview"><h2>Error</h2><kanban-entity-table-draft view="plans" error></kanban-entity-table-draft></section></div></section>`;
	}
	if (draft === "tableToolbar") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.tableToolbar}</h1><p>Search, filter, sort, count, and create controls for reusable record tables.</p></header><div class="component-stage table-toolbar"><kanban-table-toolbar-draft label="plans" count="12" action-label="New plan"></kanban-table-toolbar-draft></div></section>`;
	}
	if (draft === "graphEdge") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.graphEdge}</h1><p>A labeled connector that describes one relationship between graph records.</p></header><div class="component-stage graph-edge-stage"><kanban-graph-edge-draft label="constrains"></kanban-graph-edge-draft></div></section>`;
	}
	if (draft === "graphNode") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.graphNode}</h1><p>A focusable record summary for use in a relationship graph.</p></header><div class="component-stage graph-node-stage"><kanban-graph-node-draft reference="ISS-318" title="Snapshot refresh" tone="accent"></kanban-graph-node-draft></div></section>`;
	}
	if (draft === "relationshipGraph") {
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels.relationshipGraph}</h1><p>A relationship viewport with a legend, graph controls, and an explicit focused-record state.</p></header><div class="component-stage relationship-graph"><section class="relationship-graph-preview-state"><h2>Related records</h2><kanban-relationship-graph-draft></kanban-relationship-graph-draft></section><section class="relationship-graph-preview-state"><h2>Focused record</h2><kanban-relationship-graph-draft focus-reference="ISS-318"></kanban-relationship-graph-draft></section><section class="relationship-graph-preview-state"><h2>Empty state</h2><kanban-relationship-graph-draft empty></kanban-relationship-graph-draft></section></div></section>`;
	}
	if (["plans", "prds", "adrs", "debt", "graph", "activity"].includes(draft)) {
		const empty = draft === "plans" ? " empty" : "";
		return `<section class="component-draft"><header class="draft-caption"><span>Concept A component draft</span><h1>${draftLabels[draft]}</h1><p>Review this entity workspace in isolation, or open the overview and select the matching tab.</p></header><div class="component-stage entity-view-stage"><kanban-entity-view-draft view="${draft}"${empty}></kanban-entity-view-draft></div></section>`;
	}

	return componentPreview(draft, {
		appShell: "kanban-app-shell-draft",
		header: "kanban-header-draft",
		tabs: "kanban-tab-bar-draft",
		board: "kanban-board-draft"
	}[draft]);
}

function render() {
	const draft = new URLSearchParams(location.search).get("draft");
	const activeDraft = Object.hasOwn(draftLabels, draft) ? draft : "overview";
	const groups = [
		["Composition", ["overview", "appShell"]],
		["Primary surfaces", ["sidebar", "navigationTree", "mobileNavigationDrawer", "header", "breadcrumbTrail", "tabs", "iconButton", "button", "popoverMenu", "statusBadge", "priorityBadge", "fieldDisplay", "fieldEditor", "recordSummary", "recordToolbar", "recordDetailPanel", "selectMenu", "shortcutHint", "unsavedChanges", "skeleton", "loadingState", "keyboardFocus", "toast", "confirmDialog", "relationshipItem", "relationshipList", "commentItem", "commentComposer", "commentThread", "overlay", "issueOverlay"]],
		["Kanban", ["board", "column", "columnHeader", "card", "cardMetadata"]],
		["Entity views", ["emptyState", "noResults", "errorState", "activityEvent", "activityTimeline", "tableToolbar", "table", "plans", "prds", "adrs", "debt", "graph", "relationshipGraph", "graphNode", "graphEdge", "activity"]]
	];
	const componentRail = `<nav class="component-rail" aria-label="Component selector"><div class="rail-title">Concept A</div>${groups.map(([label, drafts]) => `<section class="rail-group"><h2>${label}</h2>${drafts.map((key) => `<button class="${key === activeDraft ? "is-active" : ""}" data-draft="${key}">${draftLabels[key]}</button>`).join("")}</section>`).join("")}</nav>`;
	document.querySelector("#app").innerHTML = `${componentRail}<main class="component-workspace">${draftView(activeDraft)}</main>`;
	document.querySelectorAll("[data-draft]").forEach((button) => button.addEventListener("click", () => {
		const url = new URL(location.href);
		url.searchParams.set("draft", button.dataset.draft);
		history.replaceState({}, "", url);
		render();
	}));
}

render();
