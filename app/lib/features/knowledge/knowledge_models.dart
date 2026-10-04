import 'package:flutter/material.dart';

import '../../core/api_client.dart';

int numberOf(Object? value) =>
    value is num ? value.toInt() : int.tryParse(textOf(value)) ?? 0;

String readableDate(String value) {
  final date = DateTime.tryParse(value)?.toLocal();
  if (date == null) return 'Not recorded';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${date.day} ${months[date.month - 1]} ${date.year}';
}

String readableBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

class KnowledgeCollection {
  KnowledgeCollection.fromJson(JsonMap value)
    : id = textOf(value['id']),
      title = textOf(value['title'], 'Untitled collection'),
      description = textOf(value['description']),
      parentId = textOf(value['parent_collection_id']),
      status = textOf(value['status'], 'active'),
      documentCount = numberOf(value['document_count']),
      sourceCount = numberOf(value['source_count']),
      permissions =
          (value['permissions'] is List
                  ? value['permissions'] as List
                  : const [])
              .map((value) => value.toString())
              .toSet();
  final String id, title, description, parentId, status;
  final int documentCount, sourceCount;
  final Set<String> permissions;
  bool can(String permission) => permissions.contains(permission);
}

/// Where a document stands in processing (`document.processing`).
///
/// Adding a document only stores it as `pending`; it becomes searchable once
/// an ingestion run processes it.
class DocumentProcessing {
  DocumentProcessing.fromJson(JsonMap value)
    : state = textOf(value['state'], 'pending'),
      error = textOf(value['error']),
      runId = textOf(value['run_id']);
  final String state, error, runId;
  bool get isProcessing => state == 'processing';
  bool get isFailed => state == 'failed';

  /// Pending and outdated documents are what a collection-wide run picks up.
  bool get awaitsRun => state == 'pending' || state == 'outdated';
  String get label => switch (state) {
    'pending' => 'Pending',
    'processing' => 'Processing',
    'ready' => 'Ready',
    'failed' => 'Failed',
    'outdated' => 'Outdated',
    'unsupported' => 'Not processed',
    _ => sentenceCase(state),
  };
}

/// Start one ingestion run, for exactly [documentIds] or for the pending and
/// outdated documents under [collectionId]. Returns the run id; a 409 carries
/// the server's explanation (for example, nothing left to process).
Future<String> startProcessing(
  ApiClient api, {
  List<String>? documentIds,
  String? collectionId,
}) async {
  final run = await api.post(
    '/ingestion-runs',
    body: {
      'document_ids': ?documentIds,
      if (collectionId != null) ...{
        'collection_id': collectionId,
        'states': const ['pending', 'outdated'],
      },
      'trigger': 'manual',
    },
  );
  return textOf(run['id']);
}

/// Whether the run is still queued or running.
Future<bool> processingIsActive(ApiClient api, String runId) async {
  final run = await api.get('/ingestion-runs/${Uri.encodeComponent(runId)}');
  return const ['queued', 'running'].contains(textOf(run['status']));
}

String sentenceCase(String value) => value.isEmpty
    ? ''
    : '${value[0].toUpperCase()}${value.substring(1).replaceAll('_', ' ')}';

class KnowledgeDocument {
  KnowledgeDocument.fromJson(JsonMap value)
    : id = textOf(value['id']),
      collectionId = textOf(value['collection_id']),
      name = textOf(value['name'], 'Untitled document'),
      contentType = textOf(value['content_type']),
      status = textOf(value['status']),
      purpose = textOf(value['purpose']),
      size = numberOf(value['size_bytes']),
      createdAt = textOf(value['created_at']),
      updatedAt = textOf(value['updated_at']),
      processing = DocumentProcessing.fromJson(objectOf(value['processing']));
  final String id,
      collectionId,
      name,
      contentType,
      status,
      purpose,
      createdAt,
      updatedAt;
  final int size;
  final DocumentProcessing processing;
  bool get isImage => contentType.startsWith('image/');
  bool get isArchive =>
      contentType.contains('zip') || name.toLowerCase().endsWith('.zip');

  /// Whether a run can take this document: its content is stored and its
  /// type can be processed.
  bool get isProcessable =>
      status == 'available' && processing.state != 'unsupported';
  bool get isFailed => status == 'failed' || processing.isFailed;
  String get statusLabel {
    if (status == 'pending_content') return 'Awaiting content';
    if (status == 'failed') return 'Content unavailable';
    return processing.label;
  }

  IconData get icon => contentType.contains('pdf')
      ? Icons.picture_as_pdf_outlined
      : isImage
      ? Icons.image_outlined
      : isArchive
      ? Icons.folder_zip_outlined
      : contentType.contains('spreadsheet') || contentType.contains('csv')
      ? Icons.table_chart_outlined
      : Icons.description_outlined;
}

class ViewerAsset {
  ViewerAsset.fromJson(JsonMap value)
    : url = textOf(value['url']),
      contentType = textOf(value['content_type']),
      page = numberOf(value['page']),
      width = numberOf(value['width']),
      height = numberOf(value['height']);
  final String url, contentType;
  final int page, width, height;
}

class ViewerElement {
  ViewerElement.fromJson(JsonMap value)
    : id = textOf(value['element_id']),
      text = textOf(value['text']),
      page = numberOf(value['page']),
      section = textOf(value['section']);
  final String id, text, section;
  final int page;
}

class CitationRegion {
  CitationRegion.fromJson(JsonMap value)
    : page = numberOf(value['page']),
      elementId = textOf(value['element_id']),
      x = _coordinate(objectOf(value['bounding_box'])['x']),
      y = _coordinate(objectOf(value['bounding_box'])['y']),
      width = _coordinate(objectOf(value['bounding_box'])['width']),
      height = _coordinate(objectOf(value['bounding_box'])['height']);
  static double _coordinate(Object? value) =>
      value is num ? value.toDouble().clamp(0.0, 1.0) : 0;
  final int page;
  final String elementId;
  final double x, y, width, height;
}

class KnowledgeViewer {
  KnowledgeViewer.fromJson(JsonMap value)
    : title = textOf(value['title'], 'Document'),
      contentType = textOf(value['content_type']),
      status = textOf(value['status']),
      externalUrl = textOf(value['external_url']),
      originalUrl =
          textOf(objectOf(objectOf(value['preview'])['original'])['url'])
              .isNotEmpty
          ? textOf(objectOf(objectOf(value['preview'])['original'])['url'])
          : textOf(value['document_url']),
      assets = objectList(objectOf(value['preview'])['assets'])
          .map(ViewerAsset.fromJson)
          .where((asset) => asset.contentType.startsWith('image/'))
          .toList(),
      elements = objectList(value['elements'])
          .map(ViewerElement.fromJson)
          .toList(),
      quote = textOf(objectOf(value['focus'])['chunk_text']),
      section = textOf(
        objectOf(objectOf(value['focus'])['citation'])['section'],
      ),
      focusPage = numberOf(
        objectOf(objectOf(value['focus'])['citation'])['page_start'],
      ),
      regions = objectList(
        objectOf(objectOf(value['focus'])['citation'])['spans'],
      ).map(CitationRegion.fromJson).toList(),
      normalizedCoordinates =
          objectOf(value['preview'])['coordinate_space'] ==
          'normalized_top_left',
      truncated = objectOf(value['preview'])['truncated'] == true,
      pageCount = numberOf(objectOf(value['preview'])['page_count']);
  final String title,
      contentType,
      status,
      externalUrl,
      originalUrl,
      quote,
      section;
  final List<ViewerAsset> assets;
  final List<ViewerElement> elements;
  final List<CitationRegion> regions;
  final int focusPage, pageCount;
  final bool normalizedCoordinates, truncated;
}
