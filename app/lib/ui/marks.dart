import 'package:flutter/material.dart';

import '../app/app_theme.dart';

const _collectionTones = [
  Tone.violet,
  Tone.indigo,
  Tone.sky,
  Tone.cyan,
  Tone.magenta,
  Tone.slate,
];

/// A stable identity tone for [seed] (a collection or person id): FNV-1a, the
/// same function the web uses, so a collection wears one colour everywhere.
Tone toneFor(String seed) {
  var hash = 0x811c9dc5;
  for (final unit in seed.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xFFFFFFFF;
  }
  return _collectionTones[hash % _collectionTones.length];
}

enum TileSize {
  small(32, 9, 17),
  medium(38, 11, 20),
  large(56, 16, 26);

  const TileSize(this.extent, this.radius, this.icon);
  final double extent, radius, icon;
}

/// A rounded square in one tone: a collection, a file type, a section, or the
/// mark of an attention card.
class ToneTile extends StatelessWidget {
  const ToneTile({
    super.key,
    required this.tone,
    required this.icon,
    this.size = TileSize.medium,
  });
  final Tone tone;
  final IconData icon;
  final TileSize size;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      width: size.extent,
      height: size.extent,
      decoration: BoxDecoration(
        color: colors.toneSurface(tone),
        borderRadius: BorderRadius.circular(size.radius),
      ),
      alignment: Alignment.center,
      child: Icon(icon, size: size.icon, color: colors.toneInk(tone)),
    );
  }
}

/// What kind of file something is, from its media type or name.
enum FileKind {
  pdf(Tone.pdf, Icons.picture_as_pdf_outlined, 'PDF'),
  sheet(Tone.sheet, Icons.table_chart_outlined, 'Sheet'),
  doc(Tone.doc, Icons.description_outlined, 'Document'),
  slide(Tone.slide, Icons.slideshow_outlined, 'Slides'),
  image(Tone.sky, Icons.image_outlined, 'Image'),
  archive(Tone.archive, Icons.folder_zip_outlined, 'ZIP'),
  text(Tone.text, Icons.notes_rounded, 'Text');

  const FileKind(this.tone, this.icon, this.label);
  final Tone tone;
  final IconData icon;
  final String label;

  static FileKind of({String contentType = '', String name = ''}) {
    final type = contentType.toLowerCase();
    final extension = name.contains('.')
        ? name.substring(name.lastIndexOf('.') + 1).toLowerCase()
        : '';
    bool any(List<String> needles, List<String> extensions) =>
        needles.any(type.contains) || extensions.contains(extension);
    if (any(['pdf'], ['pdf'])) return FileKind.pdf;
    if (any(['spreadsheet', 'excel', 'csv'], ['xlsx', 'xls', 'xlsm', 'csv'])) {
      return FileKind.sheet;
    }
    if (any(['presentation', 'powerpoint'], ['pptx', 'ppt', 'key'])) {
      return FileKind.slide;
    }
    if (any(
      ['wordprocessing', 'msword', 'opendocument.text', 'rtf'],
      ['docx', 'doc', 'odt', 'rtf'],
    )) {
      return FileKind.doc;
    }
    if (type.startsWith('image/') ||
        ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].contains(extension)) {
      return FileKind.image;
    }
    if (any(['zip', 'compressed', 'x-tar'], ['zip', 'tar', 'gz', '7z'])) {
      return FileKind.archive;
    }
    return FileKind.text;
  }

  /// The short type word shown in a file's meta line: the extension when it
  /// has one ("XLSX"), otherwise the kind.
  static String typeWord({String contentType = '', String name = ''}) {
    final dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1 && name.length - dot <= 6) {
      return name.substring(dot + 1).toUpperCase();
    }
    return FileKind.of(contentType: contentType, name: name).label;
  }
}

/// A file's tile, in its type colour.
class FileTile extends StatelessWidget {
  const FileTile({
    super.key,
    this.contentType = '',
    this.name = '',
    this.size = TileSize.medium,
  });
  final String contentType, name;
  final TileSize size;

  @override
  Widget build(BuildContext context) {
    final kind = FileKind.of(contentType: contentType, name: name);
    return ToneTile(tone: kind.tone, icon: kind.icon, size: size);
  }
}

/// One or two initials from a person's name or email.
String initialsOf(String value) {
  final text = value.trim();
  if (text.isEmpty) return '?';
  final base = text.contains('@') && !text.contains(' ')
      ? text.split('@').first
      : text;
  final words = base
      .split(RegExp(r'[\s._-]+'))
      .where((word) => word.isNotEmpty)
      .toList();
  // "Sample Admin 1" is "SA": a trailing number is not part of a name.
  final named = words
      .where(
        (word) =>
            word.characters.any((c) => c.toUpperCase() != c.toLowerCase()),
      )
      .toList();
  if (named.length >= 2) {
    return (named.first.characters.first + named.last.characters.first)
        .toUpperCase();
  }
  if (words.length >= 2) {
    return (words.first.characters.first + words.last.characters.first)
        .toUpperCase();
  }
  return words.isEmpty
      ? '?'
      : words.first.characters.take(2).toString().toUpperCase();
}

/// A person or group, by initials on their identity colour.
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({
    super.key,
    required this.name,
    this.seed,
    this.size = 38,
    this.ring = false,
  });
  final String name;

  /// What fixes the colour; defaults to [name].
  final String? seed;
  final double size;

  /// A canvas-coloured ring, for avatars that overlap in a stack.
  final bool ring;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hue = colors.tone(toneFor(seed ?? name));
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: hue,
        shape: BoxShape.circle,
        border: ring ? Border.all(color: colors.canvas, width: 2) : null,
      ),
      child: Text(
        initialsOf(name),
        maxLines: 1,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.36,
          fontWeight: FontWeight.w700,
          height: 1,
        ),
      ),
    );
  }
}

/// A few overlapping avatars: who already has access.
class AvatarStack extends StatelessWidget {
  const AvatarStack({super.key, required this.names, this.max = 3});
  final List<String> names;
  final int max;

  @override
  Widget build(BuildContext context) {
    final shown = names.take(max).toList();
    if (shown.isEmpty) return const SizedBox.shrink();
    const size = 26.0, step = 19.0;
    return SizedBox(
      width: size + step * (shown.length - 1),
      height: size,
      child: Stack(
        children: [
          for (var index = 0; index < shown.length; index++)
            Positioned(
              left: step * index,
              child: PersonAvatar(name: shown[index], size: size, ring: true),
            ),
        ],
      ),
    );
  }
}

enum StatusTone { success, warning, danger, info, neutral }

/// A status: always a word, with its colour. Never colour alone.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.tone});
  final String label;
  final StatusTone tone;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (foreground, background) = switch (tone) {
      StatusTone.success => (colors.success, colors.successSoft),
      StatusTone.warning => (colors.warning, colors.warningSoft),
      StatusTone.danger => (colors.danger, colors.dangerSoft),
      StatusTone.info => (colors.info, colors.infoSoft),
      StatusTone.neutral => (colors.ink3, colors.subtle),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 3, 9, 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: foreground,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: foreground,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              height: 1.3,
            ),
          ),
        ],
      ),
    );
  }
}

/// The product mark: the violet gradient square used on sign-in and Ask.
class BrandMark extends StatelessWidget {
  const BrandMark({
    super.key,
    this.size = 44,
    this.icon = Icons.auto_awesome_rounded,
  });
  final double size;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(size * 0.32),
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF7B68F0), Color(0xFF4A3BC6)],
      ),
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF5B4CDB).withValues(alpha: 0.45),
          blurRadius: 24,
          offset: const Offset(0, 10),
          spreadRadius: -12,
        ),
      ],
    ),
    child: Icon(icon, color: Colors.white, size: size * 0.5),
  );
}
