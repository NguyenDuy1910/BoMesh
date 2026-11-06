/**
 * Kit — shared product components on HeroUI v3 (port of the preview's `scripts/core/ui.js`
 * and `overlays.js` builders). Pages import from here instead of re-creating headers,
 * status chips, states, tables, marks, toasts or confirmations.
 */
export { AppIcon, APPS, appOf, type AppIconProps, type AppKey } from "./AppIcon";
export { BarsChart, type BarsChartProps } from "./BarsChart";
export { Callout, type CalloutProps } from "./Callout";
export { ChoiceGroup, type Choice, type ChoiceGroupProps } from "./ChoiceGroup";
export { ClearFilters, type ClearFiltersProps } from "./ClearFilters";
export { confirm, ConfirmHost, type ConfirmOptions } from "./Confirm";
export { DataTable, type DataTableColumn, type DataTableProps, type DataTableSort, type RowAction } from "./DataTable";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { ErrorState, type ErrorStateProps } from "./ErrorState";
export { FILE_KIND, FileIcon, fileExt, fileKind, fileLabel, type FileIconProps, type FileKind, type FileRef } from "./FileIcon";
export { FilterButton, type FilterButtonProps, type FilterOption } from "./FilterButton";
export { FormSection, type FormSectionProps } from "./FormSection";
export { Gate, type GateProps, type GateQuery } from "./Gate";
export { IconButton, type IconButtonProps } from "./IconButton";
export { ItemIcon, type ItemIconProps } from "./ItemIcon";
export { KeyValue, type KeyValuePair, type KeyValueProps } from "./KeyValue";
export { List, ListItem, type ListItemProps, type ListProps } from "./List";
export { NoMatches, type NoMatchesProps } from "./NoMatches";
export { Page, type PageProps } from "./Page";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Pager, paginate, type PagerProps } from "./Pager";
export { PreviewChip, type PreviewChipProps } from "./PreviewChip";
export { SaveBar, type SaveBarProps } from "./SaveBar";
export { SearchInput, type SearchInputProps } from "./SearchInput";
export { Section, type SectionProps } from "./Section";
export { SectionTabs, type SectionTab, type SectionTabsProps } from "./SectionTabs";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./Segmented";
export { SkeletonCards, type SkeletonCardsProps } from "./SkeletonCards";
export { SkeletonRows, type SkeletonRowsProps } from "./SkeletonRows";
export { Sparkline, type SparklineProps } from "./Sparkline";
export { StatCard, type StatCardProps } from "./StatCard";
export { STATUS, StatusChip, statusOf, type ChipVariant, type StatusChipProps, type StatusKind, type StatusValue, type Tone } from "./StatusChip";
export { SwitchRow, type SwitchRowProps } from "./SwitchRow";
export { Tip, type TipProps } from "./Tip";
export { closeToast, toast, ToastHost, type ToastOptions, type ToastTone } from "./Toast";
export { avatarTone, UserAvatar, type UserAvatarProps } from "./UserAvatar";
export { WorkspaceMark, type WorkspaceMarkProps } from "./WorkspaceMark";
