import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

const knowledgeFileExtensions = [
  'csv',
  'docx',
  'htm',
  'html',
  'json',
  'jsonl',
  'log',
  'markdown',
  'md',
  'pdf',
  'pptx',
  'rst',
  'sql',
  'tsv',
  'txt',
  'xlsx',
  'xml',
  'yaml',
  'yml',
];

class _QueuedFile {
  _QueuedFile(this.name, this.bytes) : key = newRequestId();
  final String name, key;
  Uint8List? bytes;
  String? error;
  bool completed = false;
}

class UploadDocumentsDialog extends StatefulWidget {
  const UploadDocumentsDialog({
    super.key,
    required this.api,
    required this.collection,
    required this.personal,
  });
  final ApiClient api;
  final KnowledgeCollection collection;
  final bool personal;
  @override
  State<UploadDocumentsDialog> createState() => _UploadDocumentsDialogState();
}

class _UploadDocumentsDialogState extends State<UploadDocumentsDialog> {
  final List<_QueuedFile> _files = [];
  bool _busy = false;
  bool _picking = false;
  String? _error;
  int _current = -1;

  Future<void> _pick() async {
    setState(() {
      _picking = true;
      _error = null;
    });
    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: [
          ...knowledgeFileExtensions,
          if (!widget.personal) 'zip',
        ],
      );
      if (!mounted) return;
      final selected = <_QueuedFile>[];
      for (final file in result) {
        final bytes = await file.readAsBytes();
        if (!mounted) return;
        if (bytes.isEmpty) {
          throw ApiException(
            '${file.name} is empty. Choose a file with content.',
          );
        }
        if (file.name.length > 240) {
          throw const ApiException(
            'File names must be 240 characters or fewer. Rename this file and try again.',
          );
        }
        final extension = file.name.split('.').last.toLowerCase();
        if (!knowledgeFileExtensions.contains(extension) &&
            !(extension == 'zip' && !widget.personal)) {
          throw ApiException(
            '${file.name} is not a supported knowledge format.',
          );
        }
        selected.add(_QueuedFile(file.name, bytes));
      }
      setState(() => _files.addAll(selected));
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  Future<void> _upload() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final token = widget.api.accessToken;
    for (var index = 0; index < _files.length; index++) {
      final file = _files[index];
      if (file.completed) continue;
      if (!mounted || token != widget.api.accessToken) return;
      setState(() {
        _current = index;
        file.error = null;
      });
      try {
        await widget.api.upload(
          '/collections/${Uri.encodeComponent(widget.collection.id)}/documents',
          fileName: file.name,
          bytes: file.bytes!,
          contentType: _contentType(file.name),
          fields: const {'purpose': 'knowledge'},
          idempotencyKey: file.key,
        );
        if (!mounted || token != widget.api.accessToken) return;
        setState(() {
          file.completed = true;
          file.bytes = null;
        });
      } catch (error) {
        if (!mounted || token != widget.api.accessToken) return;
        setState(() => file.error = error.toString());
        // Do not keep sending after authorization changed.
        if (error is ApiException && [401, 403].contains(error.status)) break;
      }
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _current = -1;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final complete = _files.where((file) => file.completed).length;
    final pending = _files.length - complete;
    return PopScope(
      canPop: !_busy,
      child: AlertDialog(
        scrollable: true,
        title: const Text('Upload documents'),
        content: SizedBox(
          width: 440,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Add to ${widget.collection.title}',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              Text(
                widget.personal
                    ? 'PDF, Office and text files. Your files are processed directly in your personal library.'
                    : 'PDF, Office and text files. ZIP archives expand into documents in this collection.',
                style: TextStyle(
                  color: context.colors.textSecondary,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Images are not knowledge. Scanned PDFs need a text layer before they can be indexed.',
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: _busy || _picking ? null : _pick,
                icon: const Icon(Icons.add),
                label: Text(_picking ? 'Choosing files…' : 'Choose files'),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: KnowledgeNotice(
                    title: 'Files could not be selected',
                    message: _error,
                    danger: true,
                  ),
                ),
              for (var i = 0; i < _files.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: context.colors.subtle,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              _files[i].completed
                                  ? Icons.check_circle_outline
                                  : Icons.description_outlined,
                              color: _files[i].completed
                                  ? context.colors.brand
                                  : context.colors.textSecondary,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                _files[i].name,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (!_busy && !_files[i].completed)
                              IconButton(
                                tooltip: 'Remove file from upload queue',
                                onPressed: () =>
                                    setState(() => _files.removeAt(i)),
                                icon: const Icon(Icons.close),
                              ),
                          ],
                        ),
                        if (_busy && _current == i) ...[
                          const SizedBox(height: 8),
                          const LinearProgressIndicator(
                            semanticsLabel: 'Uploading document',
                          ),
                          const SizedBox(height: 8),
                          const Text('Uploading and binding content…'),
                        ],
                        if (_files[i].completed)
                          const Padding(
                            padding: EdgeInsets.only(top: 8),
                            child: Text(
                              'Content uploaded. Indexing continues in the collection.',
                            ),
                          ),
                        if (_files[i].error != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              _files[i].error!,
                              style: TextStyle(color: context.colors.danger),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              if (_files.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('$complete of ${_files.length} uploaded'),
                if (!_busy && _files.any((file) => file.error != null))
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text(
                      'Retry uses the same request key, so a completed server upload will not create a duplicate.',
                    ),
                  ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: _busy
                ? null
                : () => Navigator.pop(context, complete > 0),
            child: Text(complete > 0 ? 'Done' : 'Cancel'),
          ),
          if (pending > 0)
            FilledButton(
              onPressed: _busy || _picking ? null : _upload,
              child: Text(
                _busy
                    ? 'Uploading…'
                    : _files.any((file) => file.error != null)
                    ? 'Retry remaining'
                    : 'Upload $pending file${pending == 1 ? '' : 's'}',
              ),
            ),
        ],
      ),
    );
  }
}

String _contentType(String name) => switch (name
    .split('.')
    .last
    .toLowerCase()) {
  'pdf' => 'application/pdf',
  'docx' =>
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'pptx' =>
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'zip' => 'application/zip',
  'csv' => 'text/csv',
  'tsv' => 'text/tab-separated-values',
  'html' || 'htm' => 'text/html',
  'json' || 'jsonl' => 'application/json',
  'xml' => 'application/xml',
  'md' || 'markdown' => 'text/markdown',
  _ => 'text/plain',
};
