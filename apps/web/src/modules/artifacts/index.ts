/**
 * Files in chat: artifacts the assistant makes (cards, the file panel with
 * versions) and message attachments (composer chips, attach menu, knowledge
 * picker, drop zone). ChatCore and Projects render these; Work reuses `api`.
 */
export * from "./api";
export { MIME, revisionNumber, fileNameOf, fileViewOf, formatLabel, type ExportMimeType, type FileView, type Version } from "./model";
export { artifactKeys, useArtifact, useVersions, invalidateArtifact } from "./queries";
export { confirmLeaveFileEdit, isPanelOpen, showInPanel } from "./panel-bus";
export { chipFileFromItem, useComposerFiles, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type ChipFile, type ComposerAttachments, type ComposerFile } from "./attachments";
export { ArtifactCard, ArtifactCards, type ArtifactCardProps } from "./components/ArtifactCard";
export { FilePanel, type FilePanelProps } from "./components/FilePanel";
export { AttachmentChip } from "./components/AttachmentChip";
export { AttachMenu, useFileDrop } from "./components/AttachMenu";
export { KnowledgePicker, type KnowledgePickerProps } from "./components/KnowledgePicker";
