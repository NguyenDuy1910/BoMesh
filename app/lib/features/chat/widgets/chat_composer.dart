import 'dart:async';

import 'package:flutter/material.dart';

import '../../../ui/ui.dart';
import '../services/chat_service.dart';
import '../state/chat_controller.dart';
import 'chat_sheets.dart';

/// Search scope, attachments and send/stop remain visible on every turn.
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.controller,
    required this.hint,
    this.showScope = false,
  });
  final ChatController controller;
  final String hint;

  /// The separate search scope chip, including on follow-up questions.
  final bool showScope;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _text = TextEditingController();
  final _focus = FocusNode();
  int _draftRevision = 0;

  ChatController get _controller => widget.controller;

  @override
  void initState() {
    super.initState();
    _draftRevision = _controller.draftRevision;
    _text.text = _controller.draftText;
    _controller.addListener(_syncDraft);
    _focus.addListener(_focusChanged);
  }

  @override
  void didUpdateWidget(covariant ChatComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_syncDraft);
    widget.controller.addListener(_syncDraft);
    _draftRevision = widget.controller.draftRevision;
    _text.text = widget.controller.draftText;
  }

  @override
  void dispose() {
    _controller.removeListener(_syncDraft);
    _focus.removeListener(_focusChanged);
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  /// Text the controller puts in the composer (edit, continue editing, a
  /// suggestion) replaces what is there and brings up the keyboard.
  void _syncDraft() {
    if (!mounted || _draftRevision == _controller.draftRevision) return;
    _draftRevision = _controller.draftRevision;
    final value = _controller.draftText;
    _text.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    if (value.isNotEmpty) _focus.requestFocus();
    setState(() {});
  }

  void _send() {
    final value = _text.text;
    if (!_controller.canSend(value)) return;
    _text.clear();
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {});
    unawaited(_controller.sendMessage(value));
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final controller = _controller;
    final length = _text.text.length;
    final enabled = controller.isConfigured && !controller.isLoading;
    return ColoredBox(
      color: colors.canvas,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          child: Center(
            heightFactor: 1,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (controller.hasUnavailableScope)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: InlineNotice(
                        text: 'A collection you chose is no longer available.',
                        icon: Icons.warning_amber_rounded,
                        tone: StatusTone.warning,
                        actionLabel: 'Search all',
                        onAction: controller.clearCollections,
                      ),
                    ),
                  if (widget.showScope && enabled)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(2, 0, 2, 8),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: _ScopeChip(controller: controller),
                      ),
                    ),
                  if (controller.attachments.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SizedBox(
                        height: 48,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          itemCount: controller.attachments.length,
                          separatorBuilder: (_, _) => const SizedBox(width: 8),
                          itemBuilder: (_, index) => _AttachmentChip(
                            controller: controller,
                            attachment: controller.attachments[index],
                          ),
                        ),
                      ),
                    ),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 140),
                    constraints: const BoxConstraints(minHeight: 52),
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      color: colors.canvas,
                      borderRadius: BorderRadius.circular(26),
                      border: Border.all(
                        color: _focus.hasFocus
                            ? colors.brand
                            : colors.lineStrong,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: colors.ink.withValues(alpha: 0.06),
                          blurRadius: 6,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        _RoundButton(
                          tooltip: 'Add a file',
                          icon: Icons.add_rounded,
                          background: colors.subtle,
                          foreground: colors.ink2,
                          onPressed: enabled && !controller.isGenerating
                              ? () => openAttachSheet(context, controller)
                              : null,
                        ),
                        Expanded(
                          child: TextField(
                            controller: _text,
                            focusNode: _focus,
                            enabled: enabled,
                            minLines: 1,
                            maxLines: 5,
                            maxLength: 4000,
                            textCapitalization: TextCapitalization.sentences,
                            keyboardType: TextInputType.multiline,
                            onChanged: (_) => setState(() {}),
                            style: TextStyle(
                              color: colors.ink,
                              fontSize: 16,
                              height: 1.4,
                            ),
                            decoration: InputDecoration(
                              hintText: widget.hint,
                              hintStyle: TextStyle(
                                color: colors.ink3,
                                fontSize: 16,
                              ),
                              filled: false,
                              isDense: true,
                              counterText: '',
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              disabledBorder: InputBorder.none,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 11,
                              ),
                            ),
                          ),
                        ),
                        if (controller.isGenerating)
                          _RoundButton(
                            tooltip: 'Stop response',
                            icon: Icons.stop_rounded,
                            background: colors.brand,
                            foreground: colors.onBrand,
                            onPressed: controller.stop,
                          )
                        else if (controller.canSend(_text.text))
                          _RoundButton(
                            tooltip: 'Send',
                            icon: Icons.arrow_upward_rounded,
                            background: colors.brand,
                            foreground: colors.onBrand,
                            onPressed: _send,
                          )
                        else
                          _RoundButton(
                            tooltip: 'Send',
                            icon: Icons.arrow_upward_rounded,
                            background: colors.subtle,
                            foreground: colors.ink3,
                          ),
                      ],
                    ),
                  ),
                  if (length > 3500)
                    Padding(
                      padding: const EdgeInsets.only(top: 6, right: 8),
                      child: Text(
                        '${groupedNumber(length)} / 4,000',
                        textAlign: TextAlign.right,
                        style: TextStyle(
                          color: length >= 4000 ? colors.danger : colors.ink3,
                          fontSize: 11.5,
                        ),
                      ),
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

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.tooltip,
    required this.icon,
    required this.background,
    required this.foreground,
    this.onPressed,
  });
  final String tooltip;
  final IconData icon;
  final Color background, foreground;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onPressed,
    style: IconButton.styleFrom(
      fixedSize: const Size(42, 42),
      minimumSize: const Size(42, 42),
      shape: const CircleBorder(),
      backgroundColor: background,
      foregroundColor: foreground,
      disabledBackgroundColor: background,
      disabledForegroundColor: foreground,
    ),
    icon: Icon(icon, size: 22),
  );
}

/// "All knowledge ▾" — the collections a new question searches.
class _ScopeChip extends StatelessWidget {
  const _ScopeChip({required this.controller});
  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final scoped = controller.selectedCollectionIds.isNotEmpty;
    return Material(
      color: scoped ? colors.brandSoft : colors.subtle,
      shape: StadiumBorder(
        side: BorderSide(color: scoped ? colors.brandSoft : colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: controller.isGenerating
            ? null
            : () => openScopeSheet(context, controller),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 40, maxWidth: 280),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.menu_book_outlined,
                  size: 14,
                  color: scoped ? colors.brandInk : colors.ink2,
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    scopeLabel(controller.selectedCollections),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scoped ? colors.brandInk : colors.ink2,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  Icons.expand_more_rounded,
                  size: 16,
                  color: scoped ? colors.brandInk : colors.ink2,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A file going with the question: its type, its name, and how its upload
/// is doing.
class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.controller, required this.attachment});
  final ChatController controller;
  final ComposerAttachment attachment;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final failed = attachment.progress == UploadProgress.failed;
    final uploading = !failed && attachment.progress != UploadProgress.ready;
    final document = attachment.document;
    final status = switch (attachment.progress) {
      UploadProgress.starting => 'Preparing…',
      UploadProgress.uploading => 'Uploading…',
      UploadProgress.validating => 'Checking…',
      UploadProgress.failed => 'Upload failed',
      UploadProgress.ready =>
        document?.isUpload ?? false
            ? readableBytes(document!.sizeBytes)
            : 'From Knowledge',
    };
    final chip = Container(
      padding: const EdgeInsets.fromLTRB(6, 6, 2, 6),
      decoration: BoxDecoration(
        color: colors.canvas,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: failed ? colors.danger : colors.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox.square(
            dimension: 32,
            child: uploading
                ? const Center(
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : failed
                ? const ToneTile(
                    tone: Tone.danger,
                    icon: Icons.error_outline_rounded,
                    size: TileSize.small,
                  )
                : FileTile(
                    contentType: document?.contentType ?? '',
                    name: attachment.fileName,
                    size: TileSize.small,
                  ),
          ),
          const SizedBox(width: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  attachment.fileName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    height: 1.25,
                  ),
                ),
                Text(
                  status,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: failed ? colors.danger : colors.ink3,
                    fontSize: 11.5,
                    height: 1.25,
                  ),
                ),
              ],
            ),
          ),
          if (failed)
            _ChipButton(
              tooltip: 'Retry upload',
              icon: Icons.refresh_rounded,
              onPressed: () => controller.retryAttachment(attachment.key),
            ),
          _ChipButton(
            tooltip: 'Remove file',
            icon: Icons.close_rounded,
            onPressed: () => controller.removeAttachment(attachment.key),
          ),
        ],
      ),
    );
    final error = attachment.error;
    return error == null
        ? chip
        : Tooltip(message: friendlyError(error), child: chip);
  }
}

class _ChipButton extends StatelessWidget {
  const _ChipButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });
  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onPressed,
    style: IconButton.styleFrom(
      minimumSize: const Size(34, 34),
      fixedSize: const Size(34, 34),
      padding: EdgeInsets.zero,
      foregroundColor: context.colors.ink3,
    ),
    icon: Icon(icon, size: 17),
  );
}
