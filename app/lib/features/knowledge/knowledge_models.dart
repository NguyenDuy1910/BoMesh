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

class DocumentIngestion {
  DocumentIngestion.fromJson(JsonMap value)
    : id = textOf(value['id']),
      status = textOf(value['status']),
      mode = textOf(value['mode']),
      error = textOf(value['error']),
      phase = textOf(objectOf(value['progress'])['phase']),
      discovered = numberOf(objectOf(value['progress'])['discovered_count']),
      processed = numberOf(objectOf(value['progress'])['processed_count']),
      indexed = numberOf(objectOf(value['progress'])['indexed_count']),
      failed = numberOf(objectOf(value['progress'])['failed_count']),
      attempt = numberOf(value['attempt']);
  final String id, status, mode, error, phase;
  final int discovered, processed, indexed, failed, attempt;
  bool get isActive => status == 'pending' || status == 'running';
  bool get canRetry => ['failed', 'cancelled', 'timed_out'].contains(status);
  double? get fraction =>
      discovered > 0 ? (processed / discovered).clamp(0.0, 1.0) : null;
  String get label => switch (status) {
    'pending' => 'Queued for indexing',
    'running' => phase.isEmpty ? 'Indexing' : sentenceCase(phase),
    'completed' => 'Indexed',
    'failed' => 'Indexing failed',
    'cancelled' => 'Indexing cancelled',
    'timed_out' => 'Indexing timed out',
    _ => sentenceCase(status),
  };
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
      ingestion = value['latest_ingestion'] is Map
          ? DocumentIngestion.fromJson(objectOf(value['latest_ingestion']))
          : null;
  final String id,
      collectionId,
      name,
      contentType,
      status,
      purpose,
      createdAt,
      updatedAt;
  final int size;
  final DocumentIngestion? ingestion;
  bool get isImage => contentType.startsWith('image/');
  bool get isArchive =>
      contentType.contains('zip') || name.toLowerCase().endsWith('.zip');
  bool get isActive =>
      status == 'pending_content' || ingestion?.isActive == true;
  String get statusLabel {
    if (status == 'pending_content') return 'Awaiting content';
    if (status == 'failed') return 'Content unavailable';
    if (ingestion != null) return ingestion!.label;
    return isImage ? 'Image attachment' : 'Content available';
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

class KnowledgeSearchHit {
  KnowledgeSearchHit.fromJson(JsonMap value)
    : documentId = textOf(value['document_id']),
      collectionId = textOf(value['collection_id']),
      name = textOf(value['name']),
      excerpt = textOf(value['excerpt']),
      chunkId = textOf(objectOf(value['metadata'])['chunk_id']);
  final String documentId, collectionId, name, excerpt, chunkId;
}

class CollectionGrant {
  CollectionGrant.fromJson(JsonMap value)
    : principalType = textOf(value['principal_type']),
      principalId = textOf(value['principal_id']),
      role = textOf(value['role']);
  final String principalType, principalId, role;
  String get key => '$principalType/$principalId';
}

class SharingPrincipal {
  SharingPrincipal.fromJson(JsonMap value, this.type)
    : id = textOf(value['id']),
      name = textOf(value['display_name']).isNotEmpty
          ? textOf(value['display_name'])
          : textOf(value['email']).isNotEmpty
          ? textOf(value['email'])
          : textOf(value['code'], 'Unnamed member'),
      detail = type == 'user'
          ? textOf(value['email'])
          : textOf(value['description']),
      active =
          value['status'] != false &&
          ![
            'disabled',
            'inactive',
            'suspended',
          ].contains(textOf(value['status']));
  final String id, type, name, detail;
  final bool active;
  String get key => '$type/$id';
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
