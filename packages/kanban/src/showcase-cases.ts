import { kanbanButtonShowcaseCase } from "./components/button/showcase-case.js";
import { kanbanBreadcrumbTrailShowcaseCase } from "./components/breadcrumb-trail/showcase-case.js";
import { kanbanCommentItemShowcaseCase } from "./components/comment-item/showcase-case.js";
import { kanbanIconButtonShowcaseCase } from "./components/icon-button/showcase-case.js";
import { kanbanKeyboardFocusShowcaseCase } from "./components/keyboard-focus/showcase-case.js";
import { kanbanNavigationTreeShowcaseCase } from "./components/navigation-tree/showcase-case.js";
import { kanbanPriorityBadgeShowcaseCase } from "./components/priority-badge/showcase-case.js";
import { kanbanSelectMenuShowcaseCase } from "./components/select-menu/showcase-case.js";
import { kanbanSidebarShowcaseCase } from "./components/sidebar/showcase-case.js";
import { kanbanShortcutHintShowcaseCase } from "./components/shortcut-hint/showcase-case.js";
import { kanbanSkeletonShowcaseCase } from "./components/skeleton/showcase-case.js";
import { kanbanStatusBadgeShowcaseCase } from "./components/status-badge/showcase-case.js";
import { kanbanTabsShowcaseCase } from "./components/tabs/showcase-case.js";
import type { ShowcaseCase } from "./showcase-case.js";

export const showcaseCases: readonly ShowcaseCase[] = [
	kanbanButtonShowcaseCase,
	kanbanBreadcrumbTrailShowcaseCase,
	kanbanTabsShowcaseCase,
	kanbanCommentItemShowcaseCase,
	kanbanIconButtonShowcaseCase,
	kanbanKeyboardFocusShowcaseCase,
	kanbanNavigationTreeShowcaseCase,
	kanbanPriorityBadgeShowcaseCase,
	kanbanSelectMenuShowcaseCase,
	kanbanSidebarShowcaseCase,
	kanbanShortcutHintShowcaseCase,
	kanbanSkeletonShowcaseCase,
	kanbanStatusBadgeShowcaseCase
];

export function getShowcaseCase(componentId: string | undefined): ShowcaseCase | undefined {
	return showcaseCases.find((showcaseCase) => showcaseCase.id === componentId);
}