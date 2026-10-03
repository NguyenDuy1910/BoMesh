import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/app_theme.dart';
import '../../../core/uploads.dart';
import '../services/chat_service.dart';
import '../state/chat_controller.dart';
import 'document_picker.dart';

class ChatComposer extends StatefulWidget {
  const ChatComposer({super.key, required this.controller});
  final ChatController controller;
  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _textController = TextEditingController();
  final _focusNode = FocusNode();
  int _draftRevision = 0;

  @override
  void initState() {
    super.initState();
    _draftRevision = widget.controller.draftRevision;
    _textController.text = widget.controller.draftText;
    widget.controller.addListener(_syncDraft);
    _focusNode.addListener(_focusChanged);
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  void _syncDraft() {
    if (!mounted || _draftRevision == widget.controller.draftRevision) return;
    _draftRevision = widget.controller.draftRevision;
    final value = widget.controller.draftText;
    _textController.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    if (value.isNotEmpty) _focusNode.requestFocus();
    setState(() {});
  }

  @override
  void dispose() {
    widget.controller.removeListener(_syncDraft);
    _focusNode.removeListener(_focusChanged);
    _textController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _send() {
    final value = _textController.text;
    if (!widget.controller.canSend(value)) return;
    _textController.clear();
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {});
    unawaited(widget.controller.sendMessage(value));
  }

  /// Everything that adds context to a question, in one labelled menu rather
  /// than three unlabelled icons.
  Future<void> _openAddMenu() async {
    final controller = widget.controller;
    final full = controller.attachments.length >= 10;
    final scope = controller.selectedCollectionIds.length;
    final choice = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              enabled: !full,
              leading: const Icon(Icons.upload_file_outlined),
              title: const Text('Upload a file'),
              subtitle: Text(full ? 'Up to 10 files per question' : 'PDF, Office, text or an image'),
              onTap: () => Navigator.pop(sheetContext, 'upload'),
            ),
            ListTile(
              enabled: !full,
              leading: const Icon(Icons.description_outlined),
              title: const Text('Use a document from your library'),
              onTap: () => Navigator.pop(sheetContext, 'document'),
            ),
            ListTile(
              leading: const Icon(Icons.folder_outlined),
              title: const Text('Search only some collections'),
              subtitle: Text(scope == 0 ? 'Now: everything you can access' : 'Now: $scope selected'),
              onTap: () => Navigator.pop(sheetContext, 'scope'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'upload':
        await _pickFiles();
      case 'document':
        await showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          builder: (_) => DocumentPicker(controller: controller),
        );
      case 'scope':
        await showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          builder: (_) => _CollectionPicker(controller: controller),
        );
    }
  }

  Future<void> _pickFiles() async {
    final conversationId = widget.controller.conversationId;
    try {
      final picked = await pickUploads(
        extensions: {...knowledgeExtensions, ...imageExtensions},
        limit: 10 - widget.controller.attachments.length,
      );
      if (!mounted || conversationId != widget.controller.conversationId) {
        return;
      }
      for (final file in picked.accepted) {
        unawaited(widget.controller.addAttachment(file));
      }
      if (picked.rejected.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(picked.rejected.join('\n'))),
        );
      }
    } catch (cause) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('The file could not be opened: $cause')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final colors = context.colors;
    final compact = MediaQuery.sizeOf(context).width < 600;
    return SafeArea(
      top: false,
      minimum: EdgeInsets.fromLTRB(compact ? 12 : 24, 8, compact ? 12 : 24, 8),
      child: Center(
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 864),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: colors.surface,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(
                color: _focusNode.hasFocus ? colors.brand : colors.border,
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 6, 4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (controller.hasUnavailableScope)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              'A selected collection is unavailable. Choose a new scope before sending.',
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(color: colors.danger),
                            ),
                          ),
                          TextButton(
                            onPressed: controller.clearCollections,
                            child: const Text('Clear'),
                          ),
                        ],
                      ),
                    ),
                  if (controller.selectedCollections.isNotEmpty)
                    SizedBox(
                      height: 48,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: controller.selectedCollections.length,
                        separatorBuilder: (_, _) => const SizedBox(width: 8),
                        itemBuilder: (_, index) {
                          final collection =
                              controller.selectedCollections[index];
                          return InputChip(
                            avatar: const Icon(Icons.folder_outlined, size: 18),
                            label: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 190),
                              child: Text(
                                collection.title,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            onDeleted: controller.isGenerating
                                ? null
                                : () => controller.toggleCollection(
                                    collection.id,
                                  ),
                          );
                        },
                      ),
                    ),
                  if (controller.attachments.isNotEmpty)
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 148),
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: controller.attachments.length,
                        itemBuilder: (_, index) => _AttachmentRow(
                          controller: controller,
                          attachment: controller.attachments[index],
                        ),
                      ),
                    ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      IconButton(
                        tooltip: 'Add a file or choose what to search',
                        onPressed: controller.isConfigured && !controller.isGenerating
                            ? _openAddMenu
                            : null,
                        color: controller.selectedCollectionIds.isEmpty
                            ? colors.textSecondary
                            : colors.brand,
                        icon: const Icon(Icons.add_circle_outline_rounded),
                      ),
                      Expanded(
                        child: TextField(
                          controller: _textController,
                          focusNode: _focusNode,
                          enabled: controller.isConfigured && !controller.isLoading,
                          minLines: 1,
                          maxLines: compact ? 4 : 6,
                          maxLength: 4000,
                          textCapitalization: TextCapitalization.sentences,
                          keyboardType: TextInputType.multiline,
                          onChanged: (_) => setState(() {}),
                          decoration: InputDecoration(
                            hintText: 'Ask anything',
                            filled: false,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            contentPadding: const EdgeInsets.symmetric(vertical: 10),
                            counterText: _textController.text.length > 3500
                                ? '${_textController.text.length}/4000'
                                : '',
                          ),
                          style: Theme.of(context).textTheme.bodyLarge,
                        ),
                      ),
                      IconButton.filled(
                        tooltip: controller.isGenerating
                            ? 'Stop response'
                            : 'Send message',
                        onPressed: controller.isGenerating
                            ? controller.stop
                            : controller.canSend(_textController.text)
                            ? _send
                            : null,
                        icon: Icon(
                          controller.isGenerating
                              ? Icons.stop_rounded
                              : Icons.arrow_upward_rounded,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AttachmentRow extends StatelessWidget {
  const _AttachmentRow({required this.controller, required this.attachment});
  final ChatController controller;
  final ComposerAttachment attachment;
  @override
  Widget build(BuildContext context) {
    final active =
        attachment.progress != UploadProgress.ready &&
        attachment.progress != UploadProgress.failed;
    final label =
        attachment.error ??
        switch (attachment.progress) {
          UploadProgress.starting => 'Preparing upload…',
          UploadProgress.uploading => 'Uploading…',
          UploadProgress.validating => 'Checking content…',
          UploadProgress.failed => 'Upload failed',
          UploadProgress.ready =>
            attachment.document?.isUpload == true
                ? 'Attached to your next question'
                : 'From your library',
        };
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: active
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(
              attachment.progress == UploadProgress.failed
                  ? Icons.error_outline
                  : Icons.description_outlined,
              color: attachment.error == null
                  ? context.colors.brand
                  : context.colors.danger,
            ),
      title: Text(
        attachment.fileName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        label,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: attachment.error == null ? null : context.colors.danger,
        ),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (attachment.progress == UploadProgress.failed)
            IconButton(
              tooltip: 'Retry upload',
              onPressed: () => controller.retryAttachment(attachment.key),
              icon: const Icon(Icons.refresh),
            ),
          IconButton(
            tooltip: 'Remove attachment',
            onPressed: () => controller.removeAttachment(attachment.key),
            icon: const Icon(Icons.close, size: 20),
          ),
        ],
      ),
    );
  }
}

class _CollectionPicker extends StatefulWidget {
  const _CollectionPicker({required this.controller});
  final ChatController controller;
  @override
  State<_CollectionPicker> createState() => _CollectionPickerState();
}

class _CollectionPickerState extends State<_CollectionPicker> {
  String _query = '';
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final values = controller.collections
          .where(
            (value) => value.title.toLowerCase().contains(_query.toLowerCase()),
          )
          .toList();
      return Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          16,
          20,
          MediaQuery.viewInsetsOf(context).bottom + 16,
        ),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.62,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Knowledge scope',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close scope picker',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const Text(
                'Leave selections empty to search all knowledge you can access. Select up to 20 collections.',
              ),
              const SizedBox(height: 12),
              TextField(
                decoration: const InputDecoration(
                  labelText: 'Find a collection',
                  prefixIcon: Icon(Icons.search),
                ),
                onChanged: (value) => setState(() => _query = value),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: controller.collectionsLoading
                    ? const Center(child: CircularProgressIndicator())
                    : controller.collectionsError != null
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(controller.collectionsError!),
                            TextButton.icon(
                              onPressed: controller.loadCollections,
                              icon: const Icon(Icons.refresh),
                              label: const Text('Retry'),
                            ),
                          ],
                        ),
                      )
                    : values.isEmpty
                    ? const Center(child: Text('No collections found.'))
                    : ListView.builder(
                        itemCount: values.length,
                        itemBuilder: (_, index) {
                          final value = values[index];
                          return CheckboxListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(value.title),
                            value: controller.selectedCollectionIds.contains(
                              value.id,
                            ),
                            onChanged:
                                controller.selectedCollectionIds.length < 20 ||
                                    controller.selectedCollectionIds.contains(
                                      value.id,
                                    )
                                ? (_) => controller.toggleCollection(value.id)
                                : null,
                          );
                        },
                      ),
              ),
              Row(
                children: [
                  TextButton(
                    onPressed: controller.clearCollections,
                    child: const Text('Use all permitted'),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
}
