import 'package:flutter/material.dart';

import '../app/app_theme.dart';
import 'marks.dart';
import 'format.dart';

/// Horizontal padding of every screen's content.
const kPagePadding = EdgeInsets.fromLTRB(16, 4, 16, 28);

/// Bottom padding that keeps the last row clear of a floating action button.
const kFabClearance = 96.0;

/// A screen's app bar: back (when the route can pop), a title with an
/// optional subtitle, and at most two quiet actions.
///
/// [paper] matches the warm management background; [rule] draws a hairline
/// under the bar for screens whose content scrolls beneath it.
class AppHeader extends StatelessWidget implements PreferredSizeWidget {
  const AppHeader({
    super.key,
    this.title,
    this.subtitle,
    this.leading,
    this.actions = const [],
    this.paper = false,
    this.rule = false,
    this.bottom,
    this.onTitleTap,
  });
  final String? title, subtitle;

  /// Replaces the automatic back button (for example, a History button).
  final Widget? leading;
  final List<Widget> actions;
  final VoidCallback? onTitleTap;
  final bool paper, rule;
  final PreferredSizeWidget? bottom;

  @override
  Size get preferredSize =>
      Size.fromHeight(56 + (bottom?.preferredSize.height ?? 0));

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final canPop = ModalRoute.of(context)?.canPop ?? false;
    final lead =
        leading ??
        (canPop
            ? IconButton(
                tooltip: 'Back',
                onPressed: () => Navigator.maybePop(context),
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
              )
            : null);
    return AppBar(
      automaticallyImplyLeading: false,
      backgroundColor: paper ? colors.paper : colors.canvas,
      toolbarHeight: 56,
      leadingWidth: 52,
      leading: lead == null
          ? null
          : Padding(padding: const EdgeInsets.only(left: 4), child: lead),
      titleSpacing: lead == null ? 20 : 4,
      shape: rule ? Border(bottom: BorderSide(color: colors.line)) : null,
      title: title == null
          ? null
          : InkWell(
              onTap: onTitleTap,
              borderRadius: BorderRadius.circular(10),
              child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (subtitle?.isNotEmpty ?? false)
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(fontSize: 12),
                  ),
              ],
            ),
            ),
      actions: [...actions, const SizedBox(width: 6)],
      bottom: bottom,
    );
  }
}

/// Underlined tabs under an [AppHeader] (`bottom:`), aligned with the
/// screen's content.
class AppTabBar extends StatelessWidget implements PreferredSizeWidget {
  const AppTabBar({super.key, required this.labels, this.controller});
  final List<String> labels;
  final TabController? controller;

  @override
  Size get preferredSize => const Size.fromHeight(44);

  @override
  Widget build(BuildContext context) => TabBar(
    controller: controller,
    isScrollable: true,
    padding: const EdgeInsets.symmetric(horizontal: 20),
    tabs: [for (final label in labels) Tab(height: 44, text: label)],
  );
}

/// An uppercase section label with an optional aside ("12 files", "See all").
class SectionLabel extends StatelessWidget {
  const SectionLabel(
    this.title, {
    super.key,
    this.aside,
    this.actionLabel,
    this.onAction,
    this.first = false,
  });
  final String title;
  final String? aside, actionLabel;
  final VoidCallback? onAction;

  /// The first section on a screen sits closer to the top.
  final bool first;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(4, first ? 8 : 22, 4, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(
              title,
              style: TextStyle(
                color: colors.ink3,
                fontSize: 13,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.1,
              ),
            ),
          ),
          if (actionLabel != null)
            TextButton(
              onPressed: onAction,
              child: Text(actionLabel!),
            )
          else if (aside != null)
            Text(aside!, style: TextStyle(color: colors.ink3, fontSize: 13)),
        ],
      ),
    );
  }
}

/// Rows grouped on one rounded surface, with hairlines between them.
///
/// On a paper screen the group is outlined; on a canvas screen it sits flat.
class ListGroup extends StatelessWidget {
  const ListGroup({super.key, required this.children, this.inset = 62});
  final List<Widget> children;

  /// Where the hairline between rows starts: past the leading tile.
  final double inset;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final rows = <Widget>[];
    for (var index = 0; index < children.length; index++) {
      if (index > 0) {
        rows.add(
          Padding(
            padding: EdgeInsets.only(left: inset),
            child: Divider(height: 1, color: colors.line),
          ),
        );
      }
      rows.add(children[index]);
    }
    return Container(
      decoration: BoxDecoration(
        color: colors.canvas,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        type: MaterialType.transparency,
        child: Column(children: rows),
      ),
    );
  }
}

/// One row: a lead mark, a title, a quiet meta line, and a trailing element.
/// Rows that navigate show a chevron.
class ListRow extends StatelessWidget {
  const ListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.subtitleWidget,
    this.leading,
    this.trailing,
    this.onTap,
    this.onLongPress,
    this.chevron,
    this.titleColor,
    this.maxSubtitleLines = 1,
  });
  final String title;
  final String? subtitle;

  /// A richer meta line (for example "PDF · 2 MB · Not searchable yet").
  final Widget? subtitleWidget;
  final Widget? leading, trailing;
  final VoidCallback? onTap, onLongPress;

  /// Defaults to showing a chevron when the row navigates and has no trailing.
  final bool? chevron;
  final Color? titleColor;
  final int maxSubtitleLines;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final showChevron = chevron ?? (onTap != null && trailing == null);
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 62),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
          child: Row(
            children: [
              if (leading != null) ...[leading!, const SizedBox(width: 12)],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: titleColor ?? colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.3,
                      ),
                    ),
                    if (subtitleWidget != null || subtitle != null) ...[
                      const SizedBox(height: 2),
                      DefaultTextStyle.merge(
                        style: TextStyle(
                          color: colors.ink3,
                          fontSize: 13,
                          height: 1.35,
                        ),
                        maxLines: maxSubtitleLines,
                        overflow: TextOverflow.ellipsis,
                        child:
                            subtitleWidget ??
                            Text(
                              subtitle!,
                              maxLines: maxSubtitleLines,
                              overflow: TextOverflow.ellipsis,
                            ),
                      ),
                    ],
                  ],
                ),
              ),
              if (trailing != null) ...[const SizedBox(width: 8), trailing!],
              if (showChevron)
                Padding(
                  padding: const EdgeInsets.only(left: 4),
                  child: Icon(
                    Icons.chevron_right_rounded,
                    color: colors.lineStrong,
                    size: 22,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The search field at the top of a list.
class AppSearchField extends StatefulWidget {
  const AppSearchField({
    super.key,
    required this.hint,
    required this.onChanged,
    this.controller,
    this.autofocus = false,
    this.onSubmitted,
  });
  final String hint;
  final ValueChanged<String> onChanged;
  final ValueChanged<String>? onSubmitted;
  final TextEditingController? controller;
  final bool autofocus;

  @override
  State<AppSearchField> createState() => _AppSearchFieldState();
}

class _AppSearchFieldState extends State<AppSearchField> {
  late final TextEditingController _controller =
      widget.controller ?? TextEditingController();

  @override
  void dispose() {
    if (widget.controller == null) _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      height: 44,
      decoration: BoxDecoration(
        color: colors.subtle,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const SizedBox(width: 12),
          Icon(Icons.search_rounded, size: 19, color: colors.ink3),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _controller,
              autofocus: widget.autofocus,
              textInputAction: TextInputAction.search,
              onSubmitted: widget.onSubmitted,
              onChanged: (value) {
                setState(() {});
                widget.onChanged(value);
              },
              style: TextStyle(color: colors.ink, fontSize: 15.5),
              decoration: InputDecoration(
                hintText: widget.hint,
                hintStyle: TextStyle(color: colors.ink3, fontSize: 15.5),
                filled: false,
                isCollapsed: true,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
              ),
            ),
          ),
          if (_controller.text.isNotEmpty)
            IconButton(
              tooltip: 'Clear search',
              visualDensity: VisualDensity.compact,
              onPressed: () {
                _controller.clear();
                setState(() {});
                widget.onChanged('');
              },
              icon: Icon(Icons.cancel_rounded, size: 18, color: colors.ink3),
            )
          else
            const SizedBox(width: 12),
        ],
      ),
    );
  }
}

/// A two- or three-way switch between views of the same thing.
class Segmented<T> extends StatelessWidget {
  const Segmented({
    super.key,
    required this.segments,
    required this.selected,
    required this.onChanged,
  });
  final Map<T, String> segments;
  final T selected;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.subtle,
        borderRadius: BorderRadius.circular(11),
      ),
      child: Row(
        children: [
          for (final entry in segments.entries)
            Expanded(
              child: Semantics(
                button: true,
                selected: entry.key == selected,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => onChanged(entry.key),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    height: 34,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: entry.key == selected
                          ? colors.canvas
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(9),
                      border: entry.key == selected
                          ? Border.all(color: colors.lineStrong, width: 0.5)
                          : null,
                      boxShadow: entry.key == selected
                          ? [
                              BoxShadow(
                                color: Colors.black.withValues(alpha: 0.06),
                                blurRadius: 2,
                                offset: const Offset(0, 1),
                              ),
                            ]
                          : null,
                    ),
                    child: Text(
                      entry.value,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: entry.key == selected ? colors.ink : colors.ink3,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Something that needs a decision, in colour, at the top of a screen.
class AttentionCard extends StatelessWidget {
  const AttentionCard({
    super.key,
    required this.tone,
    required this.icon,
    required this.title,
    this.subtitle,
    this.count,
    this.onTap,
  });

  /// [StatusTone.warning], [StatusTone.danger] or [StatusTone.info].
  final StatusTone tone;
  final IconData icon;
  final String title;
  final String? subtitle;
  final int? count;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (foreground, background, tileTone) = switch (tone) {
      StatusTone.danger => (colors.danger, colors.dangerSoft, Tone.danger),
      StatusTone.info => (colors.info, colors.infoSoft, Tone.info),
      StatusTone.success => (colors.success, colors.successSoft, Tone.success),
      _ => (colors.warning, colors.warningSoft, Tone.warning),
    };
    return Material(
      color: background,
      borderRadius: BorderRadius.circular(16),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 13, 10, 13),
          child: Row(
            children: [
              ToneTile(tone: tileTone, icon: icon),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (subtitle != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle!,
                        style: TextStyle(color: colors.ink2, fontSize: 13),
                      ),
                    ],
                  ],
                ),
              ),
              if (count != null)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(
                    '$count',
                    style: TextStyle(
                      color: foreground,
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.5,
                    ),
                  ),
                ),
              if (onTap != null)
                Icon(Icons.chevron_right_rounded, color: colors.ink3, size: 22),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Nothing needs you" — the calm counterpart of [AttentionCard].
class AllClearCard extends StatelessWidget {
  const AllClearCard({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: colors.successSoft,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Icon(Icons.check_circle_outline_rounded, color: colors.success),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: colors.success,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One number with its label and an optional note.
class MetricCard extends StatelessWidget {
  const MetricCard({
    super.key,
    required this.label,
    required this.value,
    this.note,
    this.onTap,
  }) : rising = false;

  /// A count with its change against the previous period ("+14%"); a rise
  /// is green, anything else stays quiet.
  MetricCard.trend({
    super.key,
    required this.label,
    required int current,
    required int previous,
    this.onTap,
  }) : value = groupedNumber(current),
       note = changeLabel(current, previous),
       rising = current > previous && previous > 0;
  final String label, value;
  final String? note;
  final bool rising;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.canvas,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(color: colors.ink3, fontSize: 13)),
              const SizedBox(height: 6),
              Text(
                value,
                style: TextStyle(
                  color: colors.ink,
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.8,
                ),
              ),
              if (note != null) ...[
                const SizedBox(height: 2),
                Text(
                  note!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: rising ? colors.success : colors.ink3,
                    fontSize: 12,
                    fontWeight: rising ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Two columns of cards that keep equal widths.
class TwoColumnGrid extends StatelessWidget {
  const TwoColumnGrid({super.key, required this.children, this.gap = 8});
  final List<Widget> children;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var index = 0; index < children.length; index += 2) {
      if (index > 0) rows.add(SizedBox(height: gap));
      rows.add(
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: children[index]),
              SizedBox(width: gap),
              Expanded(
                child: index + 1 < children.length
                    ? children[index + 1]
                    : const SizedBox.shrink(),
              ),
            ],
          ),
        ),
      );
    }
    return Column(children: rows);
  }
}

/// A quiet inline message, optionally with its one fix.
class InlineNotice extends StatelessWidget {
  const InlineNotice({
    super.key,
    required this.text,
    this.icon = Icons.info_outline_rounded,
    this.actionLabel,
    this.onAction,
    this.tone = StatusTone.neutral,
  });
  final String text;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;

  /// [StatusTone.neutral], [StatusTone.warning] or [StatusTone.danger].
  final StatusTone tone;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (background, foreground) = switch (tone) {
      StatusTone.warning => (colors.warningSoft, colors.warning),
      StatusTone.danger => (colors.dangerSoft, colors.danger),
      StatusTone.info => (colors.infoSoft, colors.info),
      StatusTone.success => (colors.successSoft, colors.success),
      StatusTone.neutral => (colors.subtle, colors.ink2),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: foreground),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: tone == StatusTone.neutral
                    ? colors.ink2
                    : Color.lerp(foreground, colors.ink, 0.25),
                fontSize: 13.5,
                height: 1.4,
              ),
            ),
          ),
          if (actionLabel != null)
            TextButton(
              onPressed: onAction,
              style: TextButton.styleFrom(
                minimumSize: const Size(44, 36),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                textStyle: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              child: Text(actionLabel!),
            ),
        ],
      ),
    );
  }
}

/// The screen's one primary action, floating bottom-right.
class AppFab extends StatelessWidget {
  const AppFab({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.busy = false,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) => FloatingActionButton.extended(
    heroTag: null,
    onPressed: busy ? null : onPressed,
    icon: busy
        ? SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: context.colors.onBrand,
            ),
          )
        : Icon(icon),
    label: Text(label),
  );
}

/// A bar pinned to the bottom of a screen, holding its primary action and an
/// optional note ("Retrying keeps the 22 that worked.").
class StickyActionBar extends StatelessWidget {
  const StickyActionBar({super.key, required this.children, this.note});
  final List<Widget> children;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: colors.canvas,
        border: Border(top: BorderSide(color: colors.line)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          child: Row(
            children: [
              if (note != null) ...[
                Expanded(
                  child: Text(
                    note!,
                    style: TextStyle(color: colors.ink3, fontSize: 13),
                  ),
                ),
                const SizedBox(width: 12),
              ],
              for (var index = 0; index < children.length; index++) ...[
                if (index > 0) const SizedBox(width: 10),
                children[index],
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The secondary button style: a quiet subtle surface with ink text.
ButtonStyle secondaryButtonStyle(BuildContext context, {bool small = false}) {
  final colors = context.colors;
  return FilledButton.styleFrom(
    backgroundColor: colors.subtle,
    foregroundColor: colors.ink,
    minimumSize: Size(44, small ? 38 : 48),
    padding: EdgeInsets.symmetric(horizontal: small ? 14 : 18),
    textStyle: TextStyle(
      fontSize: small ? 14 : 15,
      fontWeight: FontWeight.w600,
    ),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(small ? 11 : 14),
    ),
  );
}

/// The primary button style in its small size, for cards.
ButtonStyle smallPrimaryButtonStyle() => FilledButton.styleFrom(
  minimumSize: const Size(44, 38),
  padding: const EdgeInsets.symmetric(horizontal: 14),
  textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
);

/// The destructive button style: red text on a soft red surface.
ButtonStyle dangerButtonStyle(BuildContext context) {
  final colors = context.colors;
  return FilledButton.styleFrom(
    backgroundColor: colors.dangerSoft,
    foregroundColor: colors.danger,
    minimumSize: const Size(44, 48),
  );
}
