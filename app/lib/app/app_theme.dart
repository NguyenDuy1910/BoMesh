import 'package:flutter/material.dart';

/// The colours of the app, light and dark.
///
/// Cool neutral surfaces and blueprint indigo. Colour is reserved for meaning:
/// the accent marks the primary action and the current place; tones identify
/// collections and file types; status colours appear only beside a status
/// word.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.canvas,
    required this.paper,
    required this.subtle,
    required this.press,
    required this.line,
    required this.lineStrong,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.brand,
    required this.brandPress,
    required this.brandSoft,
    required this.brandInk,
    required this.onBrand,
    required this.success,
    required this.successSoft,
    required this.warning,
    required this.warningSoft,
    required this.danger,
    required this.dangerSoft,
    required this.info,
    required this.infoSoft,
    required this.codeSurface,
    required this.codeText,
    required this.tint,
    required this.dark,
  });

  /// Screens, cards and sheets.
  final Color canvas;

  /// Management backgrounds, behind grouped cards.
  final Color paper;

  /// Search fields, secondary buttons, quiet surfaces.
  final Color subtle;
  final Color press;
  final Color line;
  final Color lineStrong;

  /// Text: primary, secondary, tertiary.
  final Color ink;
  final Color ink2;
  final Color ink3;

  final Color brand;
  final Color brandPress;
  final Color brandSoft;

  /// Brand-coloured text on a soft brand surface.
  final Color brandInk;
  final Color onBrand;

  final Color success, successSoft;
  final Color warning, warningSoft;
  final Color danger, dangerSoft;
  final Color info, infoSoft;
  final Color codeSurface, codeText;

  /// Amber belongs to source evidence, independently of status and accent.
  Color get evidence => dark ? const Color(0xFFF3D06A) : const Color(0xFF6A4D00);
  Color get evidenceSoft =>
      dark ? const Color(0xFF38301D) : const Color(0xFFFFF2C2);

  /// How strongly a tone colours its tile background.
  final double tint;
  final bool dark;

  static const light = AppColors(
    canvas: Color(0xFFFFFFFF),
    paper: Color(0xFFF1F2F4),
    subtle: Color(0xFFF7F8FA),
    press: Color(0xFFE8EAEE),
    line: Color(0xFFE4E7EB),
    lineStrong: Color(0xFFD3D7DD),
    ink: Color(0xFF0E1217),
    ink2: Color(0xFF434C58),
    ink3: Color(0xFF646D79),
    brand: Color(0xFF3B38C4),
    brandPress: Color(0xFF302EA1),
    brandSoft: Color(0xFFEEEEFC),
    brandInk: Color(0xFF3431AC),
    onBrand: Color(0xFFFFFFFF),
    success: Color(0xFF1F7A48),
    successSoft: Color(0xFFE7F5ED),
    warning: Color(0xFF985A05),
    warningSoft: Color(0xFFFDF2DC),
    danger: Color(0xFFB4372B),
    dangerSoft: Color(0xFFFCEBE8),
    info: Color(0xFF2E5CC7),
    infoSoft: Color(0xFFE9F0FE),
    codeSurface: Color(0xFF17161C),
    codeText: Color(0xFFE6E4EC),
    tint: 0.13,
    dark: false,
  );

  static const night = AppColors(
    canvas: Color(0xFF13161A),
    paper: Color(0xFF0B0D10),
    subtle: Color(0xFF171A1F),
    press: Color(0xFF262B32),
    line: Color(0xFF252A31),
    lineStrong: Color(0xFF313740),
    ink: Color(0xFFECEEF1),
    ink2: Color(0xFFB9BFC8),
    ink3: Color(0xFF8E96A1),
    brand: Color(0xFF6461F0),
    brandPress: Color(0xFF7C7AF5),
    brandSoft: Color(0xFF232542),
    brandInk: Color(0xFFAAA8F7),
    onBrand: Color(0xFFFFFFFF),
    success: Color(0xFF5FD39B),
    successSoft: Color(0xFF15302A),
    warning: Color(0xFFF2BE63),
    warningSoft: Color(0xFF352A14),
    danger: Color(0xFFFF8F84),
    dangerSoft: Color(0xFF3A1D1B),
    info: Color(0xFF8FB0FF),
    infoSoft: Color(0xFF1C2742),
    codeSurface: Color(0xFF07060A),
    codeText: Color(0xFFE6E4EC),
    tint: 0.30,
    dark: true,
  );

  /// The hue of [tone] in this theme.
  Color tone(Tone tone) => switch (tone) {
    Tone.violet => const Color(0xFF6C56E0),
    Tone.indigo => const Color(0xFF4F63D9),
    Tone.sky => const Color(0xFF1F86C9),
    Tone.cyan => const Color(0xFF0E8A9A),
    Tone.magenta => const Color(0xFFC0449B),
    Tone.slate => const Color(0xFF5B6B84),
    Tone.pdf => const Color(0xFFD94343),
    Tone.sheet => const Color(0xFF2E9B62),
    Tone.doc => const Color(0xFF4D72C9),
    Tone.slide => const Color(0xFFD97728),
    Tone.text => const Color(0xFF6171D8),
    Tone.archive => const Color(0xFF7A7582),
    Tone.success => success,
    Tone.warning => warning,
    Tone.danger => danger,
    Tone.info => info,
  };

  /// A tone's tile background: the hue mixed into the canvas.
  Color toneSurface(Tone value) =>
      Color.alphaBlend(tone(value).withValues(alpha: tint), canvas);

  /// A tone's foreground on its tile: brighter in dark mode so it reads.
  Color toneInk(Tone value) =>
      dark ? Color.lerp(tone(value), Colors.white, 0.28)! : tone(value);

  AppColors withAccent(Color accent) => AppColors(
    canvas: canvas, paper: paper, subtle: subtle, press: press,
    line: line, lineStrong: lineStrong, ink: ink, ink2: ink2, ink3: ink3,
    brand: accent,
    brandPress: Color.lerp(accent, dark ? Colors.white : Colors.black, .18)!,
    brandSoft: Color.alphaBlend(accent.withValues(alpha: dark ? .20 : .09), canvas),
    brandInk: Color.lerp(accent, dark ? Colors.white : Colors.black, dark ? .45 : .12)!,
    onBrand: accent.computeLuminance() > .5 ? const Color(0xFF0B0D10) : Colors.white,
    success: success, successSoft: successSoft,
    warning: warning, warningSoft: warningSoft,
    danger: danger, dangerSoft: dangerSoft,
    info: info, infoSoft: infoSoft,
    codeSurface: codeSurface, codeText: codeText, tint: tint, dark: dark,
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(AppColors? other, double t) =>
      t < 0.5 || other == null ? this : other;
}

/// Identity and status hues. Collections take one of the first six (the same
/// as the web Knowledge page); file types take theirs; the last four only
/// ever sit beside a status word or on an attention card.
enum Tone {
  violet,
  indigo,
  sky,
  cyan,
  magenta,
  slate,
  pdf,
  sheet,
  doc,
  slide,
  text,
  archive,
  success,
  warning,
  danger,
  info,
}

abstract final class AppTheme {
  static ThemeData get light => _build(AppColors.light);
  static ThemeData get dark => _build(AppColors.night);
  static ThemeData accented({required bool dark, required Color accent}) =>
      _build((dark ? AppColors.night : AppColors.light).withAccent(accent));

  static ThemeData _build(AppColors c) {
    final brightness = c.dark ? Brightness.dark : Brightness.light;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: c.brand,
      onPrimary: c.onBrand,
      primaryContainer: c.brandSoft,
      onPrimaryContainer: c.brandInk,
      secondary: c.brand,
      onSecondary: c.onBrand,
      secondaryContainer: c.subtle,
      onSecondaryContainer: c.ink,
      error: c.danger,
      onError: c.onBrand,
      errorContainer: c.dangerSoft,
      onErrorContainer: c.danger,
      surface: c.canvas,
      onSurface: c.ink,
      onSurfaceVariant: c.ink3,
      surfaceContainerLowest: c.canvas,
      surfaceContainerLow: c.canvas,
      surfaceContainer: c.canvas,
      surfaceContainerHigh: c.subtle,
      surfaceContainerHighest: c.subtle,
      outline: c.lineStrong,
      outlineVariant: c.line,
      inverseSurface: c.ink,
      onInverseSurface: c.canvas,
      surfaceTint: Colors.transparent,
    );
    final base = ThemeData(
      fontFamily: 'IBM Plex Sans',
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: c.canvas,
      canvasColor: c.canvas,
      dividerColor: c.line,
      splashFactory: InkSparkle.splashFactory,
      extensions: <ThemeExtension<dynamic>>[c],
    );
    final rounded14 = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(14),
    );
    const buttonText = TextStyle(fontSize: 15, fontWeight: FontWeight.w600);
    return base.copyWith(
      textTheme: base.textTheme.copyWith(
        headlineMedium: TextStyle(
          color: c.ink,
          fontSize: 30,
          height: 1.12,
          fontWeight: FontWeight.w700,
          letterSpacing: -1,
        ),
        headlineSmall: TextStyle(
          color: c.ink,
          fontSize: 26,
          height: 1.15,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.8,
        ),
        titleLarge: TextStyle(
          color: c.ink,
          fontSize: 19,
          height: 1.25,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.4,
        ),
        titleMedium: TextStyle(
          color: c.ink,
          fontSize: 17,
          height: 1.3,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
        ),
        titleSmall: TextStyle(
          color: c.ink,
          fontSize: 15,
          height: 1.3,
          fontWeight: FontWeight.w600,
        ),
        bodyLarge: TextStyle(
          color: c.ink,
          fontSize: 15.5,
          height: 1.55,
          letterSpacing: -0.05,
        ),
        bodyMedium: TextStyle(color: c.ink, fontSize: 15, height: 1.45),
        bodySmall: TextStyle(color: c.ink3, fontSize: 13, height: 1.4),
        labelLarge: TextStyle(
          color: c.ink,
          fontSize: 15,
          fontWeight: FontWeight.w600,
        ),
        labelMedium: TextStyle(
          color: c.ink3,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
        labelSmall: TextStyle(
          color: c.ink3,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ).apply(fontFamily: 'IBM Plex Sans'),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 18),
          shape: rounded14,
          textStyle: buttonText,
          backgroundColor: c.brand,
          foregroundColor: c.onBrand,
          disabledBackgroundColor: c.subtle,
          disabledForegroundColor: c.ink3,
          elevation: 0,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 18),
          foregroundColor: c.ink,
          side: BorderSide(color: c.lineStrong),
          shape: rounded14,
          textStyle: buttonText,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(44, 44),
          foregroundColor: c.brandInk,
          textStyle: buttonText,
          shape: rounded14,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(44, 44),
          foregroundColor: c.ink2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: c.brand,
        foregroundColor: c.onBrand,
        elevation: 6,
        highlightElevation: 8,
        extendedTextStyle: const TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: c.canvas,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: c.line),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: c.canvas,
        surfaceTintColor: Colors.transparent,
        indicatorColor: c.brandSoft,
        indicatorShape: const StadiumBorder(),
        height: 64,
        elevation: 0,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            size: 22,
            color: states.contains(WidgetState.selected) ? c.brandInk : c.ink3,
          ),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: states.contains(WidgetState.selected) ? c.brandInk : c.ink3,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: c.canvas,
        indicatorColor: c.brandSoft,
        selectedIconTheme: IconThemeData(color: c.brandInk),
        unselectedIconTheme: IconThemeData(color: c.ink3),
        selectedLabelTextStyle: TextStyle(
          color: c.brandInk,
          fontWeight: FontWeight.w600,
          fontSize: 12,
        ),
        unselectedLabelTextStyle: TextStyle(color: c.ink3, fontSize: 12),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: c.canvas,
        foregroundColor: c.ink,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleSpacing: 0,
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: c.ink,
        unselectedLabelColor: c.ink3,
        labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        unselectedLabelStyle: const TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
        indicatorColor: c.brand,
        indicatorSize: TabBarIndicatorSize.label,
        dividerColor: c.line,
        tabAlignment: TabAlignment.start,
        labelPadding: const EdgeInsets.only(right: 22),
        overlayColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.canvas,
        hintStyle: TextStyle(color: c.ink3, fontSize: 16),
        labelStyle: TextStyle(color: c.ink3),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(13),
          borderSide: BorderSide(color: c.lineStrong),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(13),
          borderSide: BorderSide(color: c.lineStrong),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(13),
          borderSide: BorderSide(color: c.brand, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(13),
          borderSide: BorderSide(color: c.danger),
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: c.brand,
        selectionColor: c.brand.withValues(alpha: 0.25),
        selectionHandleColor: c.brand,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: c.brand,
        linearTrackColor: c.subtle,
        circularTrackColor: Colors.transparent,
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? c.onBrand : c.ink3,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? c.brand : c.subtle,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? Colors.transparent
              : c.lineStrong,
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: c.canvas,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c.canvas,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: const Color(0x66080710),
        showDragHandle: true,
        dragHandleColor: c.lineStrong,
        dragHandleSize: const Size(38, 5),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: c.ink,
        contentTextStyle: TextStyle(color: c.canvas, fontSize: 14),
        actionTextColor: c.dark ? c.brand : c.brandSoft,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: c.canvas,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: c.line),
        ),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: c.ink2,
        textColor: c.ink,
        subtitleTextStyle: TextStyle(color: c.ink3, fontSize: 13),
      ),
      dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
    );
  }
}

extension AppThemeContext on BuildContext {
  AppColors get colors =>
      Theme.of(this).extension<AppColors>() ?? AppColors.light;
}
