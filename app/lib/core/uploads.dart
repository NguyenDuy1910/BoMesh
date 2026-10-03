import 'package:file_picker/file_picker.dart';

/// What the server accepts, mirrored so a person learns about a file it would
/// refuse before waiting for it to upload (`FinxFileExtensions` on the backend).
const knowledgeExtensions = {
  'csv', 'htm', 'html', 'json', 'jsonl', 'log', 'markdown', 'md', 'rst', 'sql',
  'tsv', 'txt', 'xml', 'yaml', 'yml', 'docx', 'pptx', 'xlsx', 'pdf',
};

/// Images can be shown to the assistant in a conversation, never indexed.
const imageExtensions = {
  'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp',
};

/// The server's direct-upload limit (`DEFAULT_MAX_UPLOAD_BYTES`).
const maxUploadBytes = 100 * 1024 * 1024;

/// One file to send. Its bytes are read from disk on every attempt rather than
/// held in memory, so a retry re-reads the file and a large PDF never sits in
/// the app's heap.
class UploadSource {
  const UploadSource({
    required this.fileName,
    required this.length,
    required this.open,
  });

  final String fileName;
  final int length;
  final Stream<List<int>> Function() open;

  String get contentType => contentTypeFor(fileName);
}

/// Files the person chose, split into those that can be sent and the reasons
/// the rest cannot.
class PickedUploads {
  const PickedUploads(this.accepted, this.rejected);
  final List<UploadSource> accepted;
  final List<String> rejected;
  bool get isEmpty => accepted.isEmpty && rejected.isEmpty;
}

/// Open the system file picker and check what came back.
///
/// The picker is deliberately unfiltered. Android and iOS can only filter by
/// MIME or UTI types, and formats such as Markdown, YAML or logs have none
/// they recognise: filtered, those files appear greyed out and cannot be
/// chosen at all. Checking the extension here instead accepts every format the
/// server does and explains the ones it does not.
Future<PickedUploads> pickUploads({
  required Set<String> extensions,
  int limit = 20,
}) async {
  final files = await FilePicker.pickFiles();
  final accepted = <UploadSource>[];
  final rejected = <String>[];
  for (final file in files) {
    final extension = file.extension?.toLowerCase();
    final length = await file.length();
    if (accepted.length >= limit) {
      rejected.add('${file.name}: up to $limit files at a time');
    } else if (extension == null || !extensions.contains(extension)) {
      rejected.add(
        imageExtensions.contains(extension)
            ? '${file.name}: images can be attached in a chat, not added to the library'
            : '${file.name}: this file type is not supported',
      );
    } else if (length == 0) {
      rejected.add('${file.name}: the file is empty');
    } else if (length > maxUploadBytes) {
      rejected.add('${file.name}: larger than 100 MB');
    } else if (file.name.length > 240) {
      rejected.add('${file.name}: rename it to 240 characters or fewer');
    } else {
      accepted.add(
        UploadSource(
          fileName: file.name,
          length: length,
          open: file.readAsByteStream,
        ),
      );
    }
  }
  return PickedUploads(accepted, rejected);
}

String contentTypeFor(String fileName) =>
    switch (fileName.split('.').last.toLowerCase()) {
      'pdf' => 'application/pdf',
      'docx' =>
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xlsx' =>
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pptx' =>
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'zip' => 'application/zip',
      'csv' => 'text/csv',
      'tsv' => 'text/tab-separated-values',
      'html' || 'htm' => 'text/html',
      'json' => 'application/json',
      'jsonl' => 'application/x-ndjson',
      'xml' => 'application/xml',
      'yaml' || 'yml' => 'application/yaml',
      'md' || 'markdown' => 'text/markdown',
      'txt' || 'rst' || 'log' || 'sql' => 'text/plain',
      'png' => 'image/png',
      'jpg' || 'jpeg' => 'image/jpeg',
      'gif' => 'image/gif',
      'webp' => 'image/webp',
      'avif' => 'image/avif',
      'bmp' => 'image/bmp',
      'tif' || 'tiff' => 'image/tiff',
      _ => 'application/octet-stream',
    };
