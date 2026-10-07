import '../../core/api_client.dart';
import '../auth/session.dart';

class KnowledgeCollection {
  KnowledgeCollection.fromJson(JsonMap value)
    : id = textOf(value['id']),
      title = textOf(value['title'], 'Untitled collection'),
      description = textOf(value['description']),
      parentId = textOf(value['parent_collection_id']),
      status = textOf(value['status'], 'active'),
      documentCount = intOf(value['document_count']),
      sourceCount = intOf(value['source_count']),
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

/// Collection metadata already combines workspace and direct/inherited grants.
bool allowedOn(
  AuthSession session,
  KnowledgeCollection? collection,
  String permission,
) => collection?.can(permission) ?? session.can(permission);


/// Lower case without accents, so "thong bao" finds "Thông báo".
String foldText(String value) {
  final buffer = StringBuffer();
  for (final rune in value.toLowerCase().runes) {
    final character = String.fromCharCode(rune);
    buffer.write(_unaccented[character] ?? character);
  }
  return buffer.toString();
}

final Map<String, String> _unaccented = {
  for (final MapEntry(:key, :value) in const {
    'a': 'àáảãạăằắẳẵặâầấẩẫậäåāą',
    'c': 'çćč',
    'd': 'đď',
    'e': 'èéẻẽẹêềếểễệëēęě',
    'i': 'ìíỉĩịîïī',
    'n': 'ñńň',
    'o': 'òóỏõọôồốổỗộơờớởỡợöøō',
    'r': 'ř',
    's': 'śšş',
    't': 'ť',
    'u': 'ùúủũụưừứửữựûüūů',
    'y': 'ỳýỷỹỵÿ',
    'z': 'źżž',
  }.entries)
    for (final accented in value.split('')) accented: key,
};

/// Where a document stands in processing (`document.processing`).
///
/// Adding a document only stores it as `pending`; it becomes searchable once
/// an ingestion run processes it.
class DocumentProcessing {
  DocumentProcessing.fromJson(JsonMap value)
    : state = textOf(value['state'], 'pending'),
      error = textOf(value['error']);
  final String state, error;
  bool get isProcessing => state == 'processing';
  bool get isFailed => state == 'failed';

  /// Pending and outdated documents are what a collection-wide run picks up.
  bool get awaitsRun => state == 'pending' || state == 'outdated';

  /// The assistant cannot use it yet, and a run can change that.
  bool get notSearchable => awaitsRun || isFailed;
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

class KnowledgeDocument {
  KnowledgeDocument.fromJson(JsonMap value)
    : id = textOf(value['id']),
      collectionId = textOf(value['collection_id']),
      name = textOf(value['name'], 'Untitled document'),
      contentType = textOf(value['content_type']),
      status = textOf(value['status']),
      purpose = textOf(value['purpose']),
      size = intOf(value['size_bytes']),
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

  /// Not searchable, and a run could make it so.
  bool get needsRun => isProcessable && processing.notSearchable;

  /// Whether the assistant can be asked about it.
  bool get askable => status == 'available' && !isArchive && !isImage;
}

class ViewerAsset {
  ViewerAsset.fromJson(JsonMap value)
    : url = textOf(value['url']),
      contentType = textOf(value['content_type']),
      page = intOf(value['page']),
      width = intOf(value['width']),
      height = intOf(value['height']);
  final String url, contentType;
  final int page, width, height;
}

class ViewerElement {
  ViewerElement.fromJson(JsonMap value)
    : id = textOf(value['element_id']),
      text = textOf(value['text']),
      page = intOf(value['page']),
      section = textOf(value['section']);
  final String id, text, section;
  final int page;
}

class CitationRegion {
  CitationRegion.fromJson(JsonMap value)
    : page = intOf(value['page']),
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
      renditionUrl = textOf(
        objectOf(objectOf(value['preview'])['rendition'])['url'],
      ),
      renditionVersion = textOf(
        objectOf(objectOf(value['preview'])['rendition'])['version'],
      ),
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
      focusPage = intOf(
        objectOf(objectOf(value['focus'])['citation'])['page_start'],
      ),
      regions = objectList(
        objectOf(objectOf(value['focus'])['citation'])['spans'],
      ).map(CitationRegion.fromJson).toList(),
      normalizedCoordinates =
          objectOf(value['preview'])['coordinate_space'] ==
          'normalized_top_left',
      truncated = objectOf(value['preview'])['truncated'] == true,
      pageCount = intOf(objectOf(value['preview'])['page_count']);
  final String title,
      contentType,
      status,
      externalUrl,
      originalUrl,
      renditionUrl,
      renditionVersion,
      quote,
      section;
  final List<ViewerAsset> assets;
  final List<ViewerElement> elements;
  final List<CitationRegion> regions;
  final int focusPage, pageCount;
  final bool normalizedCoordinates, truncated;

  /// The parsed parts the citation points at.
  Set<String> get citedElementIds => {
    for (final region in regions)
      if (region.elementId.isNotEmpty) region.elementId,
  };

  /// A sheet's "pages" are its sheets.
  bool get isSpreadsheet => const {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/tab-separated-values',
  }.contains(contentType.split(';').first.trim().toLowerCase());
}

/// One typed part of the whole-document rendition (see
/// `backend/docs_design/document_viewer.md`): heading, paragraph, table,
/// code, image or link. [id] is the part's `element_id`, the same value a
/// citation span points at.
class RenditionBlock {
  RenditionBlock.fromJson(JsonMap value)
    : id = textOf(value['id']),
      kind = textOf(value['kind']),
      text = textOf(value['text']),
      level = intOf(value['level']).clamp(1, 4),
      page = value['page'] is num ? (value['page'] as num).toInt() : null,
      caption = textOf(value['caption']),
      columns = _cells(value['columns']),
      rows = value['rows'] is List
          ? [for (final row in value['rows'] as List) _cells(row)]
          : const [],
      totalRows = intOf(value['total_rows']),
      url = textOf(value['url']),
      language = textOf(value['language']);
  static List<String> _cells(Object? value) => value is List
      ? [for (final cell in value) cell == null ? '' : cell.toString()]
      : const [];

  static const kinds = {
    'heading',
    'paragraph',
    'table',
    'code',
    'image',
    'link',
  };

  final String id, kind, text, caption, url, language;
  final int level, totalRows;
  final int? page;
  final List<String> columns;
  final List<List<String>> rows;

  /// Everything the block says, for matching against a passage.
  String get allText => kind == 'table'
      ? [caption, ...columns, for (final row in rows) row.join(' ')].join(' ')
      : text;
}

class DocumentRendition {
  DocumentRendition.fromJson(JsonMap value)
    : truncated = value['truncated'] == true,
      blocks = objectList(value['blocks'])
          .map(RenditionBlock.fromJson)
          .where(
            (block) =>
                block.id.isNotEmpty &&
                RenditionBlock.kinds.contains(block.kind),
          )
          .toList() {
    if (value['schema'] != 1 || value['blocks'] is! List) {
      throw const FormatException(
        'The document text is in a format this app does not read.',
      );
    }
  }
  final bool truncated;
  final List<RenditionBlock> blocks;
}

/// What a citation points at in a rendition: the cited blocks, and the cited
/// rows of each cited table (by block id).
///
/// Span element ids name the cited blocks. A passage indexed before spans
/// carried ids falls back to the first block containing its opening words. In
/// a cited table, a row is cited when its first cell and at least one other
/// cell (or its only cell) appear in the passage as whole values.
({Set<String> blocks, Map<String, Set<int>> rows}) citedTargets(
  DocumentRendition rendition,
  Set<String> elementIds,
  String chunkText,
) {
  final passage = _normalize(chunkText);
  final cited = rendition.blocks
      .where((block) => elementIds.contains(block.id))
      .toList();
  if (cited.isEmpty && passage.isNotEmpty) {
    final opening = passage.length > 60 ? passage.substring(0, 60) : passage;
    final match = rendition.blocks
        .where((block) => _normalize(block.allText).contains(opening))
        .firstOrNull;
    if (match != null) cited.add(match);
  }
  final rows = <String, Set<int>>{};
  for (final block in cited) {
    if (block.kind != 'table' || passage.isEmpty) continue;
    final matched = {
      for (var index = 0; index < block.rows.length; index++)
        if (_rowInPassage(block.rows[index], passage)) index,
    };
    if (matched.isNotEmpty) rows[block.id] = matched;
  }
  return (blocks: {for (final block in cited) block.id}, rows: rows);
}

bool _rowInPassage(List<String> row, String passage) {
  final cells = row.map(_normalize).where((cell) => cell.length >= 2).toList();
  if (cells.isEmpty || !_quotes(passage, cells.first)) return false;
  return cells.length == 1 ||
      cells.skip(1).any((cell) => _quotes(passage, cell));
}

final _wordCharacter = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Whether [value] occurs in [passage] not as part of a longer word or number.
bool _quotes(String passage, String value) {
  for (
    var at = passage.indexOf(value);
    at >= 0;
    at = passage.indexOf(value, at + 1)
  ) {
    final before = at > 0 ? passage[at - 1] : '';
    final end = at + value.length;
    final after = end < passage.length ? passage[end] : '';
    final startsWord = _wordCharacter.hasMatch(value[0]);
    final endsWord = _wordCharacter.hasMatch(value[value.length - 1]);
    if ((before.isEmpty || !_wordCharacter.hasMatch(before) || !startsWord) &&
        (after.isEmpty || !_wordCharacter.hasMatch(after) || !endsWord)) {
      return true;
    }
  }
  return false;
}

String _normalize(String text) =>
    text.replaceAll(RegExp(r'\s+'), ' ').trim().toLowerCase();
