import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../../core/uploads.dart';
import 'knowledge_models.dart';

/// Add files to [collection] in one step: the system picker opens at once and
/// what was chosen uploads straight away. Returns whether anything was added.
///
/// Archives expand into documents only inside a workspace collection, so they
/// are offered only there.
Future<bool> uploadDocuments(
  BuildContext context, {
  required ApiClient api,
  required KnowledgeCollection collection,
  required bool personal,
}) async {
  final PickedUploads picked;
  try {
    picked = await pickUploads(
      extensions: {...knowledgeExtensions, if (!personal) 'zip'},
    );
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Files could not be opened: $error')),
      );
    }
    return false;
  }
  if (!context.mounted || picked.isEmpty) return false;
  if (picked.accepted.isEmpty) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(picked.rejected.join('\n'))));
    return false;
  }
  final added = await showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    isDismissible: false,
    enableDrag: false,
    builder: (_) => _UploadSheet(
      api: api,
      collection: collection,
      destination: personal ? 'My files' : collection.title,
      files: picked.accepted,
      skipped: picked.rejected,
    ),
  );
  return added == true;
}

enum _State { waiting, sending, done, failed }

class _Upload {
  _Upload(this.file) : key = newRequestId();
  final UploadSource file;

  /// Kept for the file's lifetime, so retrying never creates a duplicate.
  final String key;
  _State state = _State.waiting;
  String? error;
}

class _UploadSheet extends StatefulWidget {
  const _UploadSheet({
    required this.api,
    required this.collection,
    required this.destination,
    required this.files,
    required this.skipped,
  });
  final ApiClient api;
  final KnowledgeCollection collection;

  /// What the person calls this place: "My files", or the collection's name.
  final String destination;
  final List<UploadSource> files;
  final List<String> skipped;
  @override
  State<_UploadSheet> createState() => _UploadSheetState();
}

class _UploadSheetState extends State<_UploadSheet> {
  late final List<_Upload> _uploads = [
    for (final file in widget.files) _Upload(file),
  ];
  bool _running = false;

  int get _done => _uploads.where((upload) => upload.state == _State.done).length;
  bool get _anyFailed => _uploads.any((upload) => upload.state == _State.failed);

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  Future<void> _run() async {
    setState(() => _running = true);
    final token = widget.api.accessToken;
    for (final upload in _uploads) {
      if (upload.state == _State.done) continue;
      if (!mounted || token != widget.api.accessToken) return;
      setState(() {
        upload.state = _State.sending;
        upload.error = null;
      });
      try {
        await widget.api.upload(
          '/collections/${Uri.encodeComponent(widget.collection.id)}/documents',
          file: upload.file,
          fields: const {'purpose': 'knowledge'},
          idempotencyKey: upload.key,
        );
        if (!mounted) return;
        setState(() => upload.state = _State.done);
      } catch (error) {
        if (!mounted) return;
        setState(() {
          upload.state = _State.failed;
          upload.error = error.toString();
        });
        // A lost session or permission fails every remaining file the same way.
        if (error is ApiException && const [401, 403].contains(error.status)) break;
      }
    }
    if (!mounted) return;
    setState(() => _running = false);
    // Nothing to read when everything worked: close and show the list.
    if (!_anyFailed && widget.skipped.isEmpty) {
      await Future<void>.delayed(const Duration(milliseconds: 600));
      if (mounted) Navigator.pop(context, true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _running
                  ? 'Uploading to ${widget.destination}'
                  : _anyFailed
                  ? '$_done of ${_uploads.length} uploaded'
                  : 'Uploaded to ${widget.destination}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              'Documents can be asked about once indexing finishes.',
              style: TextStyle(color: colors.textSecondary),
            ),
            const SizedBox(height: 12),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final upload in _uploads)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: switch (upload.state) {
                        _State.sending => const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        _State.done => Icon(Icons.check_circle_rounded, color: colors.brand),
                        _State.failed => Icon(Icons.error_outline_rounded, color: colors.danger),
                        _State.waiting => Icon(Icons.schedule_rounded, color: colors.textMuted),
                      },
                      title: Text(
                        upload.file.fileName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: upload.error == null
                          ? null
                          : Text(
                              upload.error!,
                              style: TextStyle(color: colors.danger),
                            ),
                    ),
                  for (final reason in widget.skipped)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.block_rounded, color: colors.textMuted),
                      title: Text(reason, style: TextStyle(color: colors.textSecondary)),
                    ),
                ],
              ),
            ),
            if (!_running)
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (_anyFailed)
                    TextButton(onPressed: _run, child: const Text('Retry failed')),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: () => Navigator.pop(context, _done > 0),
                    child: const Text('Done'),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
