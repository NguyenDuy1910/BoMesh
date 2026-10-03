import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/app_theme.dart';
import '../../../core/api_client.dart';
import '../../knowledge/document_page.dart';
import '../models/chat_models.dart';
import '../state/chat_controller.dart';

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
  String? _error;
  String? _contentError;
  String? _notice;
  bool _busy = false;
  bool _contentLoading = false;
  late int _revision = widget.artifact.revision;
  int _contentRequest = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _contentRequest += 1;
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _error = null;
      _busy = true;
    });
    try {
      final detail = await widget.controller.service.artifact(
        widget.artifact.id,
      );
      if (!mounted) return;
      setState(() => _detail = detail);
      await _loadContent(_revision);
    } catch (cause) {
      if (mounted) setState(() => _error = cause.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadContent(int revision) async {
    final request = ++_contentRequest;
    setState(() {
      _revision = revision;
      _content = null;
      _contentError = null;
      _contentLoading = true;
    });
    try {
      final content = await widget.controller.service.artifactContent(
        widget.artifact.id,
        revision,
      );
      if (mounted && request == _contentRequest) {
        setState(() => _content = content);
      }
    } catch (cause) {
      if (mounted && request == _contentRequest) {
        setState(() => _contentError = cause.toString());
      }
    } finally {
      if (mounted && request == _contentRequest) {
        setState(() => _contentLoading = false);
      }
    }
  }

  Future<void> _download() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final detail = await widget.controller.service.artifact(
        widget.artifact.id,
      );
      if (!mounted) return;
      final revision = objectList(detail['revisions'])
          .where((value) => value['revision'] == _revision)
          .firstOrNull;
      final url = textOf(
        revision?['download_url'],
        detail['revision'] == _revision ? textOf(detail['download_url']) : '',
      );
      final uri = Uri.tryParse(url);
      if (uri == null || !const ['https', 'http'].contains(uri.scheme)) {
        throw const ChatArtifactException(
          'A download link is not available for this revision.',
        );
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const ChatArtifactException('Could not open the download.');
      }
    } catch (cause) {
      if (mounted) setState(() => _error = cause.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _publish() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final collections = await widget.controller.service.listCollections();
      if (!mounted) return;
      if (collections.isEmpty) {
        throw const ChatArtifactException(
          'No destination collection is available. Ask an administrator for access.',
        );
      }
      final chosen = await showDialog<ChatCollection>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Save latest revision to knowledge'),
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 0, 24, 12),
              child: Text(
                'Choose a destination. Publishing always uses the latest revision, not an older preview.',
              ),
            ),
            for (final collection in collections)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(context, collection),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(collection.title),
                ),
              ),
          ],
        ),
      );
      if (!mounted || chosen == null) return;
      final result = await widget.controller.service.publishArtifact(
        widget.artifact.id,
        chosen.id,
      );
      if (!mounted) return;
      setState(
        () => _notice = result['created'] == true
            ? 'Published to ${chosen.title}.'
            : 'Already published to ${chosen.title}.',
      );
      final documentId = textOf(result['item_id']);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_notice!),
          action: documentId.isEmpty
              ? null
              : SnackBarAction(
                  label: 'View',
                  onPressed: () {
                    if (mounted) {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => DocumentPage(
                            api: widget.controller.api,
                            documentId: documentId,
                          ),
                        ),
                      );
                    }
                  },
                ),
        ),
      );
    } catch (cause) {
      if (mounted) setState(() => _error = cause.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final revisions = objectList(_detail?['revisions']);
    final revisionNumbers = <int>{
      widget.artifact.revision,
      for (final revision in revisions)
        if (revision['revision'] is int) revision['revision'] as int,
    }.toList()..sort((a, b) => b.compareTo(a));
    final current = revisions
        .where((value) => value['revision'] == _revision)
        .firstOrNull;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.artifact.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    CircleAvatar(
                      backgroundColor: context.colors.subtle,
                      child: Icon(
                        Icons.description_outlined,
                        color: context.colors.brand,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            textOf(_detail?['title'], widget.artifact.title),
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            widget.artifact.fileName,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : _download,
                      icon: const Icon(Icons.download_outlined),
                      label: const Text('Download'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _busy || widget.controller.isGenerating
                          ? null
                          : () {
                              widget.controller.editArtifact(widget.artifact);
                              Navigator.pop(context);
                            },
                      icon: const Icon(Icons.edit_outlined),
                      label: const Text('Continue editing'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _publish,
                      icon: const Icon(Icons.library_add_outlined),
                      label: const Text('Save to knowledge'),
                    ),
                  ],
                ),
                if (_busy)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: LinearProgressIndicator(),
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _error!,
                          style: TextStyle(color: context.colors.danger),
                        ),
                        if (_detail == null)
                          TextButton.icon(
                            onPressed: _busy ? null : _load,
                            icon: const Icon(Icons.refresh),
                            label: const Text('Retry'),
                          ),
                      ],
                    ),
                  ),
                if (_notice != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      _notice!,
                      style: TextStyle(color: context.colors.brand),
                    ),
                  ),
                const SizedBox(height: 16),
                DropdownButtonFormField<int>(
                  initialValue: _revision,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Revision'),
                  items: revisionNumbers
                      .map(
                        (value) => DropdownMenuItem(
                          value: value,
                          child: Text('Revision $value'),
                        ),
                      )
                      .toList(),
                  onChanged: _busy
                      ? null
                      : (value) {
                          if (value != null) _loadContent(value);
                        },
                ),
                if (textOf(current?['summary']).isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(textOf(current?['summary'])),
                  ),
                const SizedBox(height: 20),
                if (_contentLoading)
                  const Center(child: CircularProgressIndicator())
                else if (_contentError != null)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _contentError!,
                        style: TextStyle(color: context.colors.danger),
                      ),
                      TextButton.icon(
                        onPressed: () => _loadContent(_revision),
                        icon: const Icon(Icons.refresh),
                        label: const Text('Retry preview'),
                      ),
                    ],
                  )
                else if (_content != null) ...[
                  if (_content!['truncated'] == true)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 12),
                      child: Text(
                        'This preview is shortened. Download the revision for the complete document.',
                      ),
                    ),
                  if (textOf(_content!['mime_type']).contains('markdown'))
                    MarkdownBody(
                      data: textOf(_content!['content']),
                      selectable: true,
                      onTapLink: (_, href, _) async {
                        final uri = Uri.tryParse(href ?? '');
                        if (uri != null &&
                            const ['https', 'http'].contains(uri.scheme)) {
                          await launchUrl(
                            uri,
                            mode: LaunchMode.externalApplication,
                          );
                        }
                      },
                    )
                  else
                    SelectableText(
                      textOf(_content!['content']),
                      style: Theme.of(context).textTheme.bodyMedium
                          ?.copyWith(height: 1.6),
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ChatArtifactException implements Exception {
  const ChatArtifactException(this.message);
  final String message;
  @override
  String toString() => message;
}
