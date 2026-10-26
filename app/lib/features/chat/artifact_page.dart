import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../knowledge/document_viewer.dart';
import '../knowledge/knowledge_models.dart';
import 'models/chat_models.dart';
import 'services/chat_service.dart';
import 'state/chat_controller.dart';
import 'widgets/message_view.dart';

/// Opens one revision of a file the assistant made, with a fresh link.
Future<void> downloadArtifact(
  BuildContext context,
  ChatService service,
  String artifactId,
  int revision,
) async {
  try {
    final uri = await service.artifactDownload(artifactId, revision);
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw const ChatRequestException('The download could not be opened.');
    }
  } catch (cause) {
    if (context.mounted) showError(context, cause);
  }
}

/// A file the assistant made, shown the way Knowledge shows documents: a
/// spreadsheet is a table, a text document is formatted text. Its actions
/// sit at the bottom: Download, and Save to knowledge.
class ArtifactPage extends StatefulWidget {
  const ArtifactPage({
    super.key,
    required this.artifact,
    required this.controller,
  });
  final ChatArtifact artifact;
  final ChatController controller;

  @override
  State<ArtifactPage> createState() => _ArtifactPageState();
}

class _ArtifactPageState extends State<ArtifactPage> {
  JsonMap? _detail;
  JsonMap? _content;
  Object? _error;
  JsonMap? _previousContent;
  int? _previousRevision;
  Object? _comparisonError;
  String? _savedTo;
  int _tab = 0;
  bool _loading = true;
  bool _downloading = false;
  bool _saving = false;
  late int _revision = widget.artifact.revision;
  int _request = 0;

  ChatService get _service => widget.controller.service;
  String get _fileName =>
      textOf(_detail?['file_name'], widget.artifact.fileName);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _request++;
    super.dispose();
  }

  /// The file's details (revisions) and the chosen revision's preview.
  Future<void> _load([int? revision]) async {
    final request = ++_request;
    setState(() {
      _loading = true;
      _error = null;
      _comparisonError = null;
      if (revision != null) _revision = revision;
    });
    try {
      final detail = _detail ?? await _service.artifact(widget.artifact.id);
      final content = await _service.artifactContent(
        widget.artifact.id,
        _revision,
      );
      final earlier = objectList(detail['revisions'])
          .map((value) => intOf(value['revision']))
          .where((value) => value < _revision).toList()..sort();
      final previousRevision = earlier.lastOrNull;
      JsonMap? previousContent;
      Object? comparisonError;
      if (previousRevision != null) {
        try {
          previousContent = await _service.artifactContent(widget.artifact.id, previousRevision);
        } catch (cause) {
          comparisonError = cause;
        }
      }
      if (!mounted || request != _request) return;
      setState(() {
        _detail = detail;
        _content = content;
        _previousRevision = previousRevision;
        _previousContent = previousContent;
        _comparisonError = comparisonError;
      });
    } catch (cause) {
      if (mounted && request == _request) setState(() => _error = cause);
    } finally {
      if (mounted && request == _request) setState(() => _loading = false);
    }
  }

  List<JsonMap> get _revisions =>
      objectList(_detail?['revisions'])
        ..sort((a, b) => intOf(b['revision']).compareTo(intOf(a['revision'])));

  Future<void> _download() async {
    setState(() => _downloading = true);
    await downloadArtifact(context, _service, widget.artifact.id, _revision);
    if (mounted) setState(() => _downloading = false);
  }

  Future<void> _saveToKnowledge() async {
    setState(() => _saving = true);
    try {
      final collections = await _service.listCollections(writable: true);
      if (!mounted) return;
      if (collections.isEmpty) {
        showToast(
          context,
          'You can’t add to any collection yet. Ask an administrator for access.',
        );
        return;
      }
      final chosen = await showAppSheet<ChatCollection>(
        context,
        title: 'Save to knowledge',
        subtitle: 'A copy of the latest revision goes into the collection you choose.',
        scrollable: true,
        builder: (sheet) => Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final collection in collections)
              SheetOption(
                icon: Icons.menu_book_outlined,
                tone: toneFor(collection.id),
                title: collection.title,
                onTap: () => Navigator.pop(sheet, collection),
              ),
          ],
        ),
      );
      if (!mounted || chosen == null) return;
      final result = await _service.publishArtifact(
        widget.artifact.id,
        chosen.id,
        // The server adds the stored file's extension to the title.
        title: widget.artifact.fileName.replaceFirst(RegExp(r'\.[^.]+$'), ''),
      );
      if (!mounted) return;
      setState(() => _savedTo = chosen.title);
      showToast(
        context,
        result['created'] == false
            ? 'Already in ${chosen.title}'
            : 'Saved to ${chosen.title}',
      );
    } catch (cause) {
      if (mounted) showError(context, cause);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _askForChanges() {
    widget.controller.editArtifact(widget.artifact);
    Navigator.pop(context);
  }

  Widget _history() => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      for (final revision in _revisions)
        ListTile(
          leading: const Icon(Icons.history_rounded),
          title: Text('Version ${intOf(revision['revision'])}'),
          subtitle: Text([
            textOf(revision['summary']),
            exactTime(revision['created_at']),
          ].where((value) => value.isNotEmpty).join(' · ')),
          selected: intOf(revision['revision']) == _revision,
          trailing: intOf(revision['revision']) == _revision
              ? const Icon(Icons.check_rounded) : null,
          onTap: () {
            setState(() => _tab = 0);
            unawaited(_load(intOf(revision['revision'])));
          },
        ),
    ],
  );

  Widget _changes() {
    if (_comparisonError != null) {
      return ErrorView(
        error: _comparisonError!,
        title: 'The previous version could not be loaded',
        onRetry: _load,
      );
    }
    final previous = _previousContent;
    if (previous == null) {
      return const Center(child: Padding(
        padding: EdgeInsets.all(24),
        child: Text('This is the first version. There is no earlier version to compare.'),
      ));
    }
    final before = textOf(previous['content']);
    final after = textOf(_content?['content']);
    if (before.isNotEmpty || after.isNotEmpty) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          InlineNotice(text: before == after
              ? 'The text is unchanged between these versions.'
              : 'Compare the full text of versions $_previousRevision and $_revision below.'),
          SectionLabel('Version $_previousRevision · before'),
          SelectableText(before.isEmpty ? 'No text content.' : before),
          SectionLabel('Version $_revision · after'),
          SelectableText(after.isEmpty ? 'No text content.' : after),
        ],
      );
    }
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Text('Version $_previousRevision → $_revision. Compare the original previews; automatic binary differences are not available.'),
        ),
        Expanded(
          child: PageView(
            children: [
              _ArtifactPreview(
                key: ValueKey('before-$_previousRevision'),
                artifactId: widget.artifact.id,
                revision: _previousRevision!,
                content: previous,
                fileName: _fileName,
                onRetry: () => unawaited(_load()),
              ),
              _ArtifactPreview(
                key: ValueKey('after-$_revision'),
                artifactId: widget.artifact.id,
                revision: _revision,
                content: _content!,
                fileName: _fileName,
                onRetry: () => unawaited(_load()),
              ),
            ],
          ),
        ),
        const Padding(
          padding: EdgeInsets.all(8),
          child: Text('Swipe to compare the previous and selected versions.'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_loading) {
      body = const LoadingView();
    } else if (_error != null) {
      body = ErrorView(
        error: _error!,
        title: 'The preview could not be loaded',
        onRetry: _load,
      );
    } else if (_tab == 1) {
      body = _changes();
    } else if (_tab == 2) {
      body = _history();
    } else {
      body = _ArtifactPreview(
        key: ValueKey(_revision),
        artifactId: widget.artifact.id,
        revision: _revision,
        content: _content!,
        fileName: _fileName,
        onRetry: () => unawaited(_load()),
      );
    }
    return Scaffold(
      appBar: AppHeader(
        title: _fileName,
        subtitle: 'Revision $_revision · made in this chat',
        rule: true,
        actions: [
          IconButton(
            tooltip: 'Download this version',
            onPressed: _downloading ? null : _download,
            icon: const Icon(Icons.download_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('Preview')),
                ButtonSegment(value: 1, label: Text('Changes')),
                ButtonSegment(value: 2, label: Text('History')),
              ],
              selected: {_tab},
              onSelectionChanged: (value) => setState(() => _tab = value.single),
            ),
          ),
          if (_savedTo != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: InlineNotice(text: 'Latest version saved to $_savedTo.'),
            ),
          Expanded(child: body),
        ],
      ),
      bottomNavigationBar: StickyActionBar(
        children: [
          FilledButton(
            style: secondaryButtonStyle(context),
            onPressed: _saving ? null : _saveToKnowledge,
            child: _saving
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Save to knowledge'),
          ),
          Expanded(
            child: FilledButton.icon(
              onPressed: widget.controller.isGenerating ? null : _askForChanges,
              icon: const Icon(Icons.edit_outlined, size: 20),
              label: const Text('Ask for changes'),
            ),
          ),
        ],
      ),
    );
  }
}

/// One revision's preview, read the way Knowledge reads documents: the
/// viewer's rendition (a spreadsheet is a table, a Word file is formatted
/// text) or its page images. Markdown is formatted text, CSV a table, and an
/// image is shown as itself.
class _ArtifactPreview extends StatefulWidget {
  const _ArtifactPreview({
    super.key,
    required this.artifactId,
    required this.revision,
    required this.content,
    required this.fileName,
    required this.onRetry,
  });
  final String artifactId;
  final int revision;
  final JsonMap content;
  final String fileName;

  /// Reads the revision again, which also re-signs its preview links.
  final VoidCallback onRetry;

  @override
  State<_ArtifactPreview> createState() => _ArtifactPreviewState();
}

class _ArtifactPreviewState extends State<_ArtifactPreview> {
  late final KnowledgeViewer _viewer = KnowledgeViewer.fromJson({
    'title': widget.fileName,
    'content_type': textOf(widget.content['mime_type']),
    'preview': widget.content['preview'],
  });
  Future<DocumentRendition>? _rendition;

  String get _mime => textOf(widget.content['mime_type']).toLowerCase();
  String get _name => widget.fileName.toLowerCase();
  bool get _markdown =>
      _mime.contains('markdown') ||
      _name.endsWith('.md') ||
      _name.endsWith('.markdown');
  bool get _tabular =>
      _mime.contains('csv') ||
      _mime.contains('tab-separated') ||
      _name.endsWith('.csv') ||
      _name.endsWith('.tsv');

  @override
  void initState() {
    super.initState();
    if (!_markdown && !_tabular && _viewer.renditionUrl.isNotEmpty) {
      _rendition = loadRendition(
        'artifact:${widget.artifactId}:${widget.revision}',
        _viewer,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = textOf(widget.content['content']);
    final shortened = widget.content['truncated'] == true;
    if (_markdown) {
      return _page([
        if (shortened) _shortened,
        SelectionArea(
          child: MarkdownBody(
            data: text,
            softLineBreak: true,
            styleSheet: chatMarkdownStyle(context),
            onTapLink: (_, href, _) => unawaited(openExternalLink(href)),
          ),
        ),
      ]);
    }
    if (_tabular) {
      final rows = _parseDelimited(
        text,
        _mime.contains('tab-separated') || _name.endsWith('.tsv') ? '\t' : ',',
      );
      if (rows.isEmpty) return _empty();
      return _page([
        if (shortened) _shortened,
        TableBlockView(
          block: RenditionBlock.fromJson({
            'id': 'table',
            'kind': 'table',
            'columns': rows.first,
            'rows': rows.skip(1).toList(),
            'total_rows': rows.length - 1,
          }),
        ),
      ]);
    }
    final rendition = _rendition;
    if (rendition != null) {
      return FutureBuilder<DocumentRendition>(
        future: rendition,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const LoadingView();
          }
          final value = snapshot.data;
          if (snapshot.hasError || value == null) {
            return _fallback(
              text,
              notice: InlineNotice(
                tone: StatusTone.danger,
                text: friendlyError(snapshot.error ?? 'No preview'),
                actionLabel: 'Try again',
                onAction: widget.onRetry,
              ),
            );
          }
          return CustomScrollView(
            slivers: [
              SliverPadding(
                padding: _padding,
                sliver: RenditionSliver(
                  rendition: value,
                  spreadsheet: _viewer.isSpreadsheet,
                  citedBlocks: const {},
                  citedRows: const {},
                ),
              ),
            ],
          );
        },
      );
    }
    return _fallback(text);
  }

  /// Without a rendition: the image itself, its page images, or its text.
  Widget _fallback(String text, {Widget? notice}) {
    final lead = [
      if (notice != null)
        Padding(padding: const EdgeInsets.only(bottom: 12), child: notice),
    ];
    if (_mime.startsWith('image/') && _viewer.originalUrl.isNotEmpty) {
      return _page([
        ...lead,
        InteractiveViewer(
          maxScale: 5,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.network(
              _viewer.originalUrl,
              fit: BoxFit.contain,
              semanticLabel: widget.fileName,
              loadingBuilder: (context, child, progress) =>
                  progress == null ? child : const LoadingView(),
              errorBuilder: (context, _, _) => InlineNotice(
                text: 'This image couldn’t be loaded.',
                actionLabel: 'Try again',
                onAction: widget.onRetry,
              ),
            ),
          ),
        ),
      ]);
    }
    if (_viewer.assets.isNotEmpty) {
      return _page([
        ...lead,
        PageViewer(viewer: _viewer, onRetry: widget.onRetry),
      ]);
    }
    if (_mime.startsWith('text/') && text.trim().isNotEmpty) {
      return _page([
        ...lead,
        if (widget.content['truncated'] == true) _shortened,
        SelectableText(
          text,
          style: TextStyle(
            color: context.colors.ink,
            fontSize: 14.5,
            height: 1.55,
          ),
        ),
      ]);
    }
    if (lead.isNotEmpty) return _page(lead);
    return _empty();
  }

  Widget _empty() => const EmptyView(
    icon: Icons.insert_drive_file_outlined,
    title: 'No preview for this file',
    message: 'Download it to open it on your phone.',
  );

  static const _padding = EdgeInsets.fromLTRB(16, 14, 16, 28);

  Widget _page(List<Widget> children) =>
      ListView(padding: _padding, children: children);
}

const _shortened = Padding(
  padding: EdgeInsets.only(bottom: 12),
  child: InlineNotice(
    text: 'This preview is shortened. Download the file for all of it.',
  ),
);

/// Rows of a comma- or tab-separated text, honouring quoted fields.
List<List<String>> _parseDelimited(String text, String delimiter) {
  final source = text.startsWith('\uFEFF') ? text.substring(1) : text;
  final rows = <List<String>>[];
  var row = <String>[];
  final field = StringBuffer();
  var quoted = false;
  for (var index = 0; index < source.length; index++) {
    final char = source[index];
    if (quoted) {
      if (char == '"') {
        if (index + 1 < source.length && source[index + 1] == '"') {
          field.write('"');
          index++;
        } else {
          quoted = false;
        }
      } else {
        field.write(char);
      }
    } else if (char == '"' && field.isEmpty) {
      quoted = true;
    } else if (char == delimiter) {
      row.add(field.toString());
      field.clear();
    } else if (char == '\n' || char == '\r') {
      if (char == '\r' &&
          index + 1 < source.length &&
          source[index + 1] == '\n') {
        index++;
      }
      row.add(field.toString());
      field.clear();
      rows.add(row);
      row = <String>[];
    } else {
      field.write(char);
    }
  }
  if (field.isNotEmpty || row.isNotEmpty) {
    row.add(field.toString());
    rows.add(row);
  }
  return rows
      .where((value) => !(value.length == 1 && value.single.trim().isEmpty))
      .toList();
}
