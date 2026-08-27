import { kanbanButtonShowcaseCase } from "./components/button/showcase-case.js";
import { kanbanBreadcrumbTrailShowcaseCase } from "./components/breadcrumb-trail/showcase-case.js";
import { kanbanCommentItemShowcaseCase } from "./components/comment-item/showcase-case.js";
import { kanbanNavigationTreeShowcaseCase } from "./components/navigation-tree/showcase-case.js";
import { kanbanSidebarShowcaseCase } from "./components/sidebar/showcase-case.js";
import { kanbanTabsShowcaseCase } from "./components/tabs/showcase-case.js";
import type { ShowcaseCase } from "./showcase-case.js";

export const showcaseCases: readonly ShowcaseCase[] = [
	kanbanButtonShowcaseCase,
	kanbanBreadcrumbTrailShowcaseCase,
	kanbanTabsShowcaseCase,
	kanbanCommentItemShowcaseCase,
	kanbanNavigationTreeShowcaseCase,
	kanbanSidebarShowcaseCase
];

export function getShowcaseCase(componentId: string | undefined): ShowcaseCase | undefined {
	return showcaseCases.find((showcaseCase) => showcaseCase.id === componentId);
}