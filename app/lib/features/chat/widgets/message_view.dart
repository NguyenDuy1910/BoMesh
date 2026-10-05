import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../ui/ui.dart';
import '../../knowledge/document_page.dart';
import '../artifact_page.dart';
import '../models/chat_models.dart';
import '../state/chat_controller.dart';
import 'chat_sheets.dart';

/// One turn of the conversation: the person's question on the right, or the
/// assistant's work, answer, sources and files on the left.
class ChatMessageView extends StatelessWidget {
  const ChatMessageView({
    super.key,
    required this.message,
    required this.controller,
    required this.isStreaming,
    this.question = '',
  });

  final ChatMessage message;
  final ChatController controller;
  final bool isStreaming;

  /// The question an answer replies to; its words are marked in sources.
  final String question;

  @override
  Widget build(BuildContext context) => message.role == ChatRole.user
      ? _UserBubble(message: message, controller: controller)
      : _AssistantTurn(
          message: message,
          controller: controller,
          isStreaming: isStreaming,
          question: question,
        );
}

/// The answer's text style: 15.5 on 1.6, used for answers and previews.
MarkdownStyleSheet chatMarkdownStyle(
  BuildContext context, {
  bool muted = false,
}) {
  final colors = context.colors;
  final theme = Theme.of(context).textTheme;
  final body = TextStyle(
    color: muted ? colors.ink2 : colors.ink,
    fontSize: 15.5,
    height: 1.6,
  );
  return MarkdownStyleSheet(
    p: body,
    a: body.copyWith(
      color: colors.brandInk,
      decoration: TextDecoration.underline,
      decorationColor: colors.brandInk,
    ),
    strong: body.copyWith(fontWeight: FontWeight.w700),
    em: body.copyWith(fontStyle: FontStyle.italic),
    listBullet: body,
    h1: theme.titleLarge,
    h2: theme.titleMedium,
    h3: theme.titleSmall,
    h1Padding: const EdgeInsets.only(top: 10, bottom: 4),
    h2Padding: const EdgeInsets.only(top: 8, bottom: 2),
    h3Padding: const EdgeInsets.only(top: 6),
    blockSpacing: 10,
    listIndent: 22,
    blockquote: body.copyWith(color: colors.ink2),
    blockquotePadding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
    blockquoteDecoration: BoxDecoration(
      color: colors.subtle,
      border: Border(left: BorderSide(color: colors.lineStrong, width: 3)),
      borderRadius: const BorderRadius.horizontal(right: Radius.circular(12)),
    ),
    code: TextStyle(
      color: colors.codeText,
      backgroundColor: colors.codeSurface,
      fontFamily: 'monospace',
      fontSize: 13,
      height: 1.5,
    ),
    codeblockPadding: const EdgeInsets.all(14),
    codeblockDecoration: BoxDecoration(
      color: colors.codeSurface,
      borderRadius: BorderRadius.circular(12),
    ),
    tableHead: body.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700),
    tableBody: body.copyWith(fontSize: 13.5, height: 1.4),
    tableBorder: TableBorder.all(
      color: colors.line,
      borderRadius: BorderRadius.circular(12),
    ),
    tableHeadAlign: TextAlign.left,
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    tableCellsDecoration: BoxDecoration(color: colors.canvas),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: colors.line)),
    ),
  );
}

/// Opens an http(s) or mail link outside the app; anything else is ignored.
Future<void> openExternalLink(String? href) async {
  final uri = href == null ? null : Uri.tryParse(href);
  if (uri != null && const ['https', 'http', 'mailto'].contains(uri.scheme)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

/// A cited source: its passage in a sheet, then the document or a question
/// about it.
Future<void> _openSource(
  BuildContext context,
  ChatController controller,
  AnswerSource source,
  String question,
) async {
  final action = await showSourceSheet(
    context,
    service: controller.service,
    source: source,
    question: question,
  );
  if (!context.mounted || action == null) return;
  switch (action) {
    case SourceAction.open:
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => DocumentPage(
            documentId: source.itemId,
            chunkId: source.chunkId,
            offerAsk: false,
          ),
        ),
      );
    case SourceAction.ask:
      if (controller.isGenerating) {
        showToast(context, 'Wait for this answer to finish, then ask again.');
      } else {
        controller.referenceDocument(source.itemId, source.title);
      }
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.message, required this.controller});
  final ChatMessage message;
  final ChatController controller;

  Future<void> _actions(BuildContext context) async {
    final edit = await showAppSheet<bool>(
      context,
      builder: (sheet) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (message.text.isNotEmpty)
            SheetOption(
              icon: Icons.edit_outlined,
              title: 'Edit question',
              subtitle: controller.isGenerating
                  ? 'Available when this answer finishes'
                  : 'Puts it back in the composer',
              onTap: controller.isGenerating
                  ? null
                  : () => Navigator.pop(sheet, true),
            ),
          SheetOption(
            icon: Icons.copy_rounded,
            title: 'Copy',
            onTap: () => Navigator.pop(sheet, false),
          ),
        ],
      ),
    );
    if (!context.mounted || edit == null) return;
    if (edit) {
      controller.setDraft(message.text);
    } else {
      await Clipboard.setData(ClipboardData(text: message.text));
      if (context.mounted) showToast(context, 'Copied');
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final width = MediaQuery.sizeOf(context).width;
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 18),
      child: Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: (width * 0.82).clamp(0, 560)),
          child: GestureDetector(
            onLongPress: () => _actions(context),
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
              decoration: BoxDecoration(
                color: colors.subtle,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(20),
                  topRight: Radius.circular(20),
                  bottomLeft: Radius.circular(20),
                  bottomRight: Radius.circular(6),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final document in message.documents)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _AttachedFile(document: document),
                    ),
                  if (message.text.isNotEmpty)
                    Text(
                      message.text,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15.5,
                        height: 1.45,
                      ),
                    ),
                  if (message.collections.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.menu_book_outlined,
                            size: 14,
                            color: colors.ink3,
                          ),
                          const SizedBox(width: 5),
                          Flexible(
                            child: Text(
                              'In ${scopeLabel(message.collections)}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: colors.ink3,
                                fontSize: 12.5,
                              ),
                            ),
                          ),
                        ],
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

/// A file that went with a question; opens the document.
class _AttachedFile extends StatelessWidget {
  const _AttachedFile({required this.document});
  final ConversationDocument document;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.canvas,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                DocumentPage(documentId: document.id, offerAsk: false),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 6, 10, 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              FileTile(
                contentType: document.contentType,
                name: document.fileName,
                size: TileSize.small,
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  document.fileName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AssistantTurn extends StatelessWidget {
  const _AssistantTurn({
    required this.message,
    required this.controller,
    required this.isStreaming,
    required this.question,
  });
  final ChatMessage message;
  final ChatController controller;
  final bool isStreaming;
  final String question;

  @override
  Widget build(BuildContext context) {
    final turn = message.turn;
    final items = turn?.presentationItems ?? const <AssistantTurnItem>[];
    final sources = turn?.sources ?? const <AnswerSource>[];
    final artifacts = turn?.artifacts ?? const <ChatArtifact>[];
    final text = message.displayText;
    final error = turn?.error;
    final settled = !isStreaming;
    void openSource(AnswerSource source) =>
        _openSource(context, controller, source, question);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final item in items)
            switch (item.kind) {
              AssistantTurnItemKind.message => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _Answer(
                  text: item.text,
                  muted: item.phase == 'commentary',
                  sources: sources,
                  onCite: openSource,
                ),
              ),
              AssistantTurnItemKind.tool || AssistantTurnItemKind.reasoning =>
                _WorkLine(item: item, streaming: isStreaming),
            },
          if (isStreaming && (turn?.modelPending ?? true)) const _Pending(),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: InlineNotice(
                text: friendlyError(error),
                icon: Icons.error_outline_rounded,
                tone: StatusTone.danger,
                actionLabel: controller.isGenerating ? null : 'Retry',
                onAction: () => unawaited(controller.regenerate(message.id)),
              ),
            ),
          for (final artifact in artifacts)
            _FileCard(artifact: artifact, controller: controller),
          if (settled && sources.isNotEmpty)
            _SourcesRow(sources: sources, onOpen: openSource),
          if (settled && text.isNotEmpty)
            _TurnActions(
              text: text,
              onRegenerate: controller.isGenerating || error != null
                  ? null
                  : () => unawaited(controller.regenerate(message.id)),
            ),
        ],
      ),
    );
  }
}

class _Answer extends StatelessWidget {
  const _Answer({
    required this.text,
    required this.muted,
    required this.sources,
    required this.onCite,
  });
  final String text;
  final bool muted;
  final List<AnswerSource> sources;
  final ValueChanged<AnswerSource> onCite;

  @override
  Widget build(BuildContext context) => SelectionArea(
    child: MarkdownBody(
      data: _linkCitations(text, sources),
      softLineBreak: true,
      styleSheet: chatMarkdownStyle(context, muted: muted),
      builders: {'a': _LinkBuilder(sources: sources, onCite: onCite)},
    ),
  );
}

/// Draws a citation as a small numbered chip inside the sentence, and any
/// other link as underlined text that opens outside the app.
class _LinkBuilder extends MarkdownElementBuilder {
  _LinkBuilder({required this.sources, required this.onCite});
  final List<AnswerSource> sources;
  final ValueChanged<AnswerSource> onCite;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final href = element.attributes['href'];
    final uri = href == null ? null : Uri.tryParse(href);
    if (uri?.scheme == 'citation') {
      final number = int.tryParse(uri!.path);
      final source = sources
          .where((value) => value.number == number)
          .firstOrNull;
      if (source != null) {
        return Text.rich(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: _CitationChip(number: number!, onTap: () => onCite(source)),
          ),
        );
      }
    }
    final colors = context.colors;
    return Text.rich(
      TextSpan(
        text: element.textContent,
        style: (parentStyle ?? preferredStyle)?.copyWith(
          color: colors.brandInk,
          decoration: TextDecoration.underline,
          decorationColor: colors.brandInk,
        ),
        recognizer: TapGestureRecognizer()
          ..onTap = () => unawaited(openExternalLink(href)),
      ),
    );
  }
}

class _CitationChip extends StatelessWidget {
  const _CitationChip({required this.number, required this.onTap});
  final int number;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      button: true,
      label: 'Source $number',
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 1, vertical: 4),
          child: Container(
            height: 19,
            constraints: const BoxConstraints(minWidth: 19),
            padding: const EdgeInsets.symmetric(horizontal: 5),
            decoration: BoxDecoration(
              color: colors.brandSoft,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Center(
              widthFactor: 1,
              child: Text(
                '$number',
                style: TextStyle(
                  color: colors.brandInk,
                  fontSize: 11.5,
                  height: 1.2,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One quiet line for one thing the assistant did. A code step shows its
/// command and opens the full commands; a reasoning step opens its summary.
class _WorkLine extends StatelessWidget {
  const _WorkLine({required this.item, required this.streaming});
  final AssistantTurnItem item;

  /// Whether the turn is still running; a step left running by an
  /// interrupted turn no longer spins.
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final reasoning = item.kind == AssistantTurnItemKind.reasoning;
    final running = item.state == 'active' || item.state == 'in_progress';
    final active = streaming && running;
    final state = running && !streaming
        ? (reasoning ? 'completed' : 'skipped')
        : item.state;
    final failed = state == 'failed' || state == 'timeout';
    final code = item.name == 'hosted_execution';
    final label = reasoning
        ? (active ? 'Thinking…' : 'Thought it through')
        : _toolLabel(item.name, state, item.resultCount);
    final Widget lead;
    if (active) {
      lead = const SizedBox.square(
        dimension: 14,
        child: CircularProgressIndicator(strokeWidth: 1.8),
      );
    } else if (failed) {
      lead = Icon(Icons.error_outline_rounded, size: 16, color: colors.danger);
    } else if (state == 'skipped') {
      lead = Icon(Icons.remove_circle_outline, size: 16, color: colors.ink3);
    } else if (code) {
      lead = Icon(Icons.terminal_rounded, size: 16, color: colors.ink3);
    } else if (reasoning) {
      lead = Icon(
        Icons.lightbulb_outline_rounded,
        size: 16,
        color: colors.ink3,
      );
    } else {
      lead = Icon(Icons.check_rounded, size: 16, color: colors.success);
    }
    final details = reasoning
        ? item.text.trim().isNotEmpty
        : item.commands.isNotEmpty;
    final line = Padding(
      padding: const EdgeInsets.only(top: 3, bottom: 7),
      child: Row(
        children: [
          lead,
          const SizedBox(width: 8),
          Text(
            label,
            style: TextStyle(
              color: failed ? colors.danger : colors.ink3,
              fontSize: 13.5,
            ),
          ),
          if (item.commands.isNotEmpty) ...[
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                item.commands.first.replaceAll('\n', ' '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: colors.ink3,
                  fontFamily: 'monospace',
                  fontSize: 12,
                ),
              ),
            ),
          ],
        ],
      ),
    );
    return Semantics(
      liveRegion: active,
      child: details
          ? InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => reasoning
                  ? _showReasoning(context, item.text)
                  : _showCommands(context, item.commands),
              child: line,
            )
          : line,
    );
  }
}

Future<void> _showCommands(BuildContext context, List<String> commands) {
  final colors = context.colors;
  return showAppSheet<void>(
    context,
    title: 'Code that ran',
    subtitle: countOf(commands.length, 'command'),
    scrollable: true,
    builder: (_) => Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final command in commands)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: colors.codeSurface,
              borderRadius: BorderRadius.circular(12),
            ),
            child: SelectableText(
              command,
              style: TextStyle(
                color: colors.codeText,
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.5,
              ),
            ),
          ),
      ],
    ),
  );
}

Future<void> _showReasoning(BuildContext context, String text) =>
    showAppSheet<void>(
      context,
      title: 'How it got there',
      scrollable: true,
      builder: (sheet) => SelectableText(
        text.trim(),
        style: TextStyle(
          color: sheet.colors.ink2,
          fontSize: 14.5,
          height: 1.55,
        ),
      ),
    );

String _toolLabel(String name, String state, int? resultCount) {
  final (active, done, failed) = switch (name) {
    'knowledge_search' => (
      'Searching your knowledge…',
      switch (resultCount) {
        null => 'Searched your knowledge',
        0 => 'Found no matching sources',
        final count => 'Searched ${countOf(count, 'source')}',
      },
      'Couldn’t search your knowledge',
    ),
    'read_resource' => (
      'Reading a document…',
      'Read a document',
      'Couldn’t read a document',
    ),
    'inspect_resource' => (
      'Looking through a document…',
      'Looked through a document',
      'Couldn’t look through a document',
    ),
    'materialize_resource' || 'materialize_sandbox_resource' => (
      'Opening a document…',
      'Opened a document',
      'Couldn’t open a document',
    ),
    'document_edit' => (
      'Editing a file…',
      'Edited a file',
      'Couldn’t edit the file',
    ),
    'artifact_create' => (
      'Making a file…',
      'Made a file',
      'Couldn’t make the file',
    ),
    'hosted_execution' => ('Running code…', 'Ran code', 'Code didn’t finish'),
    _ => ('Working…', 'Finished a step', 'A step didn’t finish'),
  };
  return switch (state) {
    'active' => active,
    'failed' => failed,
    'timeout' => '$failed in time',
    'skipped' => 'Skipped a step',
    _ => done,
  };
}

/// Before the first words arrive: three soft dots.
class _Pending extends StatefulWidget {
  const _Pending();

  @override
  State<_Pending> createState() => _PendingState();
}

class _PendingState extends State<_Pending>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse
        ..stop()
        ..value = 0.5;
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = context.colors.ink3;
    return Semantics(
      liveRegion: true,
      label: 'The assistant is working',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: AnimatedBuilder(
          animation: _pulse,
          builder: (context, _) => Row(
            children: [
              for (var index = 0; index < 3; index++)
                Container(
                  width: 7,
                  height: 7,
                  margin: const EdgeInsets.only(right: 5),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: color.withValues(
                      alpha: 0.25 + 0.6 * _wave(_pulse.value - index * 0.18),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  static double _wave(double value) {
    final t = value % 1;
    return t < 0.5 ? t * 2 : (1 - t) * 2;
  }
}

/// A file the assistant made: what it is, and its two real actions.
class _FileCard extends StatefulWidget {
  const _FileCard({required this.artifact, required this.controller});
  final ChatArtifact artifact;
  final ChatController controller;

  @override
  State<_FileCard> createState() => _FileCardState();
}

class _FileCardState extends State<_FileCard> {
  bool _downloading = false;

  Future<void> _download() async {
    setState(() => _downloading = true);
    await downloadArtifact(
      context,
      widget.controller.service,
      widget.artifact.id,
      widget.artifact.revision,
    );
    if (mounted) setState(() => _downloading = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final artifact = widget.artifact;
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.canvas,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              FileTile(contentType: artifact.mimeType, name: artifact.fileName),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      artifact.fileName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        FileKind.typeWord(
                          contentType: artifact.mimeType,
                          name: artifact.fileName,
                        ),
                        if (artifact.sizeBytes > 0)
                          readableBytes(artifact.sizeBytes),
                        'Revision ${artifact.revision}',
                      ].join(' · '),
                      style: TextStyle(color: colors.ink3, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  style: smallPrimaryButtonStyle(),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => ArtifactPage(
                        artifact: artifact,
                        controller: widget.controller,
                      ),
                    ),
                  ),
                  icon: const Icon(Icons.visibility_outlined, size: 18),
                  label: const Text('Preview'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.icon(
                  style: secondaryButtonStyle(context, small: true),
                  onPressed: _downloading ? null : _download,
                  icon: _downloading
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.download_rounded, size: 18),
                  label: const Text('Download'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The sources an answer cites, side by side under it.
class _SourcesRow extends StatelessWidget {
  const _SourcesRow({required this.sources, required this.onOpen});
  final List<AnswerSource> sources;
  final ValueChanged<AnswerSource> onOpen;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 6),
      child: SizedBox(
        height: 44,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: sources.length,
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (context, index) {
            final source = sources[index];
            return Material(
              color: colors.subtle,
              borderRadius: BorderRadius.circular(12),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => onOpen(source),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(6, 6, 10, 6),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (source.number != null) ...[
                        Container(
                          height: 18,
                          constraints: const BoxConstraints(minWidth: 18),
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          decoration: BoxDecoration(
                            color: colors.canvas,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Center(
                            widthFactor: 1,
                            child: Text(
                              '${source.number}',
                              style: TextStyle(
                                color: colors.brandInk,
                                fontSize: 11,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                      ],
                      FileTile(name: source.title, size: TileSize.small),
                      const SizedBox(width: 8),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 140),
                        child: Text(
                          source.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: colors.ink,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _TurnActions extends StatelessWidget {
  const _TurnActions({required this.text, required this.onRegenerate});
  final String text;
  final VoidCallback? onRegenerate;

  @override
  Widget build(BuildContext context) {
    final style = IconButton.styleFrom(
      minimumSize: const Size(38, 38),
      fixedSize: const Size(38, 38),
      foregroundColor: context.colors.ink3,
    );
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Transform.translate(
        offset: const Offset(-10, 0),
        child: Row(
          children: [
            IconButton(
              tooltip: 'Copy',
              style: style,
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: text));
                if (context.mounted) showToast(context, 'Copied');
              },
              icon: const Icon(Icons.copy_rounded, size: 18),
            ),
            if (onRegenerate != null)
              IconButton(
                tooltip: 'Regenerate',
                style: style,
                onPressed: onRegenerate,
                icon: const Icon(Icons.refresh_rounded, size: 19),
              ),
          ],
        ),
      ),
    );
  }
}

/// Turns the answer's "[1]" markers into citation links, leaving code and
/// existing links alone. Adjacent markers ("[1][2]") are each linked: the
/// server writes one marker per cited source, side by side.
String _linkCitations(String text, List<AnswerSource> sources) {
  final numbers = sources
      .map((source) => source.number)
      .whereType<int>()
      .toSet();
  if (numbers.isEmpty) return text;
  final pattern = RegExp(
    r'(`{3}[\s\S]*?`{3}|`[^`]*`|\[[^\]]*\]\([^)]*\)|\[(?!\d{1,3}\])[^\]]*\]\[[^\]]*\])|\[(\d{1,3})\](?!\()',
  );
  return text.replaceAllMapped(pattern, (match) {
    final number = int.tryParse(match.group(2) ?? '');
    return number != null && numbers.contains(number)
        ? '[$number](citation:$number)'
        : match.group(0)!;
  });
}
