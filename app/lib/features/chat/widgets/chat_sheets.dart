import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/uploads.dart';
import '../../../ui/ui.dart';
import '../library_picker_page.dart';
import '../models/chat_models.dart';
import '../services/chat_service.dart';
import '../state/chat_controller.dart';

enum _AttachChoice { upload, library }

/// Attachments and search scope are separate composer controls.
Future<void> openAttachSheet(
  BuildContext context,
  ChatController controller,
) async {
  final full = controller.attachments.length >= 10;
  final choice = await showAppSheet<_AttachChoice>(
    context,
    title: 'Add to this question',
    subtitle: 'Attach a file for the assistant to read.',
    builder: (sheet) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetOption(
          icon: Icons.upload_rounded,
          tone: Tone.violet,
          title: 'Upload a file',
          subtitle: full
              ? 'Up to 10 files per question'
              : 'PDF, Office, CSV, text or an image',
          onTap: full ? null : () => Navigator.pop(sheet, _AttachChoice.upload),
        ),
        SheetOption(
          icon: Icons.local_library_outlined,
          tone: Tone.indigo,
          title: 'Choose from Knowledge',
          subtitle: full
              ? 'Up to 10 files per question'
              : 'Your files and shared collections',
          onTap: full
              ? null
              : () => Navigator.pop(sheet, _AttachChoice.library),
        ),
      ],
    ),
  );
  if (!context.mounted || choice == null) return;
  switch (choice) {
    case _AttachChoice.upload:
      await pickAttachments(context, controller);
    case _AttachChoice.library:
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => LibraryPickerPage(controller: controller),
        ),
      );
  }
}

/// Lets the person choose files on the phone and starts their uploads.
Future<void> pickAttachments(
  BuildContext context,
  ChatController controller,
) async {
  final conversationId = controller.conversationId;
  try {
    final picked = await pickUploads(
      extensions: {...knowledgeExtensions, ...imageExtensions},
      limit: 10 - controller.attachments.length,
    );
    if (!context.mounted || conversationId != controller.conversationId) {
      return;
    }
    for (final file in picked.accepted) {
      unawaited(controller.addAttachment(file));
    }
    if (picked.rejected.isNotEmpty) {
      showToast(context, picked.rejected.join('\n'));
    }
  } catch (cause) {
    if (context.mounted) showError(context, cause);
  }
}

/// "All knowledge", one collection's name, or how many were chosen.
String scopeLabel(List<ChatCollection> scope) => switch (scope.length) {
  0 => 'All knowledge',
  1 => scope.single.title,
  2 => '${scope.first.title}, ${scope.last.title}',
  _ => countOf(scope.length, 'collection'),
};

/// Which collections answers may come from: everything, or a chosen few.
Future<void> openScopeSheet(BuildContext context, ChatController controller) {
  if (controller.collections.isEmpty && !controller.collectionsLoading) {
    unawaited(controller.loadCollections());
  }
  return showAppSheet<void>(
    context,
    title: 'Search in',
    subtitle: 'Answers come only from what you choose, up to 20 collections.',
    builder: (_) => _ScopeSheet(controller: controller),
  );
}

class _ScopeSheet extends StatefulWidget {
  const _ScopeSheet({required this.controller});
  final ChatController controller;

  @override
  State<_ScopeSheet> createState() => _ScopeSheetState();
}

class _ScopeSheetState extends State<_ScopeSheet> {
  String _query = '';

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final selected = controller.selectedCollectionIds;
      final needle = _query.trim().toLowerCase();
      final values = controller.collections
          .where((value) => value.title.toLowerCase().contains(needle))
          .toList();
      final Widget list;
      if (controller.collectionsLoading && controller.collections.isEmpty) {
        list = const LoadingView(label: 'Loading collections');
      } else if (controller.collectionsError != null &&
          controller.collections.isEmpty) {
        list = Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: InlineNotice(
            text: friendlyError(controller.collectionsError!),
            icon: Icons.error_outline_rounded,
            tone: StatusTone.danger,
            actionLabel: 'Retry',
            onAction: controller.loadCollections,
          ),
        );
      } else {
        list = ListView(
          shrinkWrap: true,
          children: [
            if (needle.isEmpty)
              SheetOption(
                icon: Icons.auto_awesome_rounded,
                tone: Tone.violet,
                title: 'All knowledge',
                subtitle: 'Everything you’re allowed to read',
                trailing: _Check(on: selected.isEmpty),
                onTap: controller.clearCollections,
              ),
            for (final collection in values)
              SheetOption(
                icon: Icons.menu_book_outlined,
                tone: toneFor(collection.id),
                title: collection.title,
                trailing: _Check(on: selected.contains(collection.id)),
                onTap: selected.length < 20 || selected.contains(collection.id)
                    ? () => controller.toggleCollection(collection.id)
                    : null,
              ),
            if (values.isEmpty && needle.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  'No collection matches “$_query”.',
                  style: TextStyle(color: context.colors.ink3, fontSize: 14),
                ),
              ),
          ],
        );
      }
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (controller.collections.length > 8)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: AppSearchField(
                hint: 'Find a collection',
                onChanged: (value) => setState(() => _query = value),
              ),
            ),
          Flexible(child: list),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      );
    },
  );
}

/// A multi-select mark: a filled violet circle with a check when chosen.
class _Check extends StatelessWidget {
  const _Check({required this.on});
  final bool on;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 140),
      width: 22,
      height: 22,
      margin: const EdgeInsets.only(left: 10),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: on ? colors.brand : Colors.transparent,
        border: on ? null : Border.all(color: colors.lineStrong, width: 2),
      ),
      child: on
          ? Icon(Icons.check_rounded, size: 15, color: colors.onBrand)
          : null,
    );
  }
}

enum SourceAction { open, ask }

/// Browse every cited passage without losing the selected document focus.
Future<({SourceAction action, AnswerSource source})?> showSourceSheet(
  BuildContext context, {
  required ChatService service,
  required AnswerSource source,
  List<AnswerSource> sources = const [],
  String question = '',
}) {
  final passages = sources.isEmpty ? [source] : sources;
  var index = passages.indexWhere((value) =>
      value.itemId == source.itemId && value.chunkId == source.chunkId);
  if (index < 0) index = 0;
  return showAppSheet<({SourceAction action, AnswerSource source})>(
    context,
    title: 'Sources',
    scrollable: true,
    builder: (sheet) => StatefulBuilder(
      builder: (context, update) {
        final selected = passages[index];
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(selected.title, style: Theme.of(context).textTheme.titleMedium),
            if (selected.locator != null) Text(selected.locator!),
            Row(
              children: [
                IconButton(
                  tooltip: 'Previous passage',
                  onPressed: index == 0 ? null : () => update(() => index--),
                  icon: const Icon(Icons.chevron_left_rounded),
                ),
                Expanded(child: Text(
                  'Passage ${index + 1} of ${passages.length}',
                  textAlign: TextAlign.center,
                )),
                IconButton(
                  tooltip: 'Next passage',
                  onPressed: index + 1 == passages.length
                      ? null : () => update(() => index++),
                  icon: const Icon(Icons.chevron_right_rounded),
                ),
              ],
            ),
            _Passage(
              key: ValueKey('${selected.itemId}:${selected.chunkId}'),
              service: service, source: selected, question: question,
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () => Navigator.pop(sheet,
                  (action: SourceAction.open, source: selected)),
              child: const Text('Open at passage'),
            ),
            const SizedBox(height: 8),
            FilledButton(
              style: secondaryButtonStyle(sheet),
              onPressed: () => Navigator.pop(sheet,
                  (action: SourceAction.ask, source: selected)),
              child: const Text('Ask about this source'),
            ),
          ],
        );
      },
    ),
  );
}

class _Passage extends StatefulWidget {
  const _Passage({
    super.key,
    required this.service,
    required this.source,
    required this.question,
  });
  final ChatService service;
  final AnswerSource source;
  final String question;

  @override
  State<_Passage> createState() => _PassageState();
}

class _PassageState extends State<_Passage> {
  late Future<String> _passage = _load();

  Future<String> _load() => widget.service.citationPassage(
    widget.source.itemId,
    widget.source.chunkId,
  );

  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
    future: _passage,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const SizedBox(
          height: 96,
          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
        );
      }
      if (snapshot.hasError) {
        return InlineNotice(
          text: friendlyError(snapshot.error!),
          icon: Icons.error_outline_rounded,
          tone: StatusTone.danger,
          actionLabel: 'Retry',
          onAction: () => setState(() => _passage = _load()),
        );
      }
      final text = snapshot.data ?? '';
      if (text.isEmpty) {
        return const InlineNotice(
          text:
              'This passage has no text to show. Open the document to see it.',
        );
      }
      final colors = context.colors;
      return Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(
          color: colors.evidenceSoft,
          border: Border(left: BorderSide(color: colors.evidence, width: 3)),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(4),
            bottomLeft: Radius.circular(4),
            topRight: Radius.circular(14),
            bottomRight: Radius.circular(14),
          ),
        ),
        child: SelectableText.rich(
          TextSpan(
            style: TextStyle(color: colors.ink, fontSize: 14.5, height: 1.55),
            children: _highlight(
              text,
              widget.question,
              colors.evidence.withValues(alpha: 0.26),
            ),
          ),
        ),
      );
    },
  );
}

/// The passage with the question's own words marked, so the reason it was
/// cited is visible at a glance.
List<TextSpan> _highlight(String text, String question, Color mark) {
  final terms =
      RegExp(r'[\p{L}\p{N}]{4,}', unicode: true)
          .allMatches(question.toLowerCase())
          .map((match) => RegExp.escape(match.group(0)!))
          .toSet()
          .toList()
        ..sort((a, b) => b.length.compareTo(a.length));
  if (terms.isEmpty) return [TextSpan(text: text)];
  final pattern = RegExp(terms.take(12).join('|'), caseSensitive: false);
  final spans = <TextSpan>[];
  var start = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > start) {
      spans.add(TextSpan(text: text.substring(start, match.start)));
    }
    spans.add(
      TextSpan(
        text: match.group(0),
        style: TextStyle(backgroundColor: mark),
      ),
    );
    start = match.end;
  }
  if (start < text.length) spans.add(TextSpan(text: text.substring(start)));
  return spans;
}
