import 'package:flutter/material.dart';

@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.appBackground,
    required this.surface,
    required this.sidebar,
    required this.subtle,
    required this.hover,
    required this.selected,
    required this.border,
    required this.borderStrong,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.brand,
    required this.brandHover,
    required this.brandSoft,
    required this.onBrand,
    required this.danger,
    required this.dangerSoft,
    required this.codeSurface,
    required this.codeText,
  });

  final Color appBackground;
  final Color surface;
  final Color sidebar;
  final Color subtle;
  final Color hover;
  final Color selected;
  final Color border;
  final Color borderStrong;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color brand;
  final Color brandHover;
  final Color brandSoft;
  final Color onBrand;
  final Color danger;
  final Color dangerSoft;
  final Color codeSurface;
  final Color codeText;

  static const light = AppColors(
    appBackground: Color(0xFFF6F7FB),
    surface: Color(0xFFFFFFFF),
    sidebar: Color(0xFFF0F2F8),
    subtle: Color(0xFFF8F9FC),
    hover: Color(0xFFECECEA),
    selected: Color(0xFFEEEEFF),
    border: Color(0xFFE2E5EF),
    borderStrong: Color(0xFFB8BECE),
    textPrimary: Color(0xFF18181B),
    textSecondary: Color(0xFF52525B),
    textMuted: Color(0xFF71717A),
    brand: Color(0xFF5B5BD6),
    brandHover: Color(0xFF4F46C8),
    brandSoft: Color(0xFFEEEEFF),
    onBrand: Color(0xFFFFFFFF),
    danger: Color(0xFFB42335),
    dangerSoft: Color(0xFFFFF1F1),
    codeSurface: Color(0xFF18181B),
    codeText: Color(0xFFE4E4E7),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(AppColors? other, double t) =>
      t < 0.5 || other == null ? this : other;
}

abstract final class AppTheme {
  static ThemeData get light => _build(AppColors.light);

  static ThemeData _build(AppColors colors) {
    final colorScheme = ColorScheme(
      brightness: Brightness.light,
      primary: colors.brand,
      onPrimary: colors.onBrand,
      secondary: colors.brand,
      onSecondary: colors.onBrand,
      error: colors.danger,
      onError: Colors.white,
      surface: colors.surface,
      onSurface: colors.textPrimary,
      outline: colors.borderStrong,
      outlineVariant: colors.border,
      surfaceContainerHighest: colors.subtle,
    );
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: colors.appBackground,
      canvasColor: colors.surface,
      dividerColor: colors.border,
      extensions: <ThemeExtension<dynamic>>[colors],
    );
    return base.copyWith(
      textTheme: base.textTheme.copyWith(
        headlineSmall: TextStyle(
          color: colors.textPrimary,
          fontSize: 26,
          height: 1.2,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.7,
        ),
        titleLarge: TextStyle(
          color: colors.textPrimary,
          fontSize: 18,
          height: 1.25,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.25,
        ),
        titleMedium: TextStyle(
          color: colors.textPrimary,
          fontSize: 15,
          height: 1.35,
          fontWeight: FontWeight.w600,
        ),
        bodyLarge: TextStyle(
          color: colors.textPrimary,
          fontSize: 16,
          height: 1.58,
          letterSpacing: -0.05,
        ),
        bodyMedium: TextStyle(
          color: colors.textPrimary,
          fontSize: 14,
          height: 1.5,
        ),
        bodySmall: TextStyle(
          color: colors.textMuted,
          fontSize: 12,
          height: 1.45,
        ),
        labelLarge: TextStyle(
          color: colors.textPrimary,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(48, 52),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 50),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          side: BorderSide(color: colors.borderStrong),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: colors.surface,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: colors.border),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: colors.surface,
        indicatorColor: colors.brandSoft,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected)
                ? colors.brand
                : colors.textSecondary,
          ),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            color: states.contains(WidgetState.selected)
                ? colors.brand
                : colors.textSecondary,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w600
                : FontWeight.w500,
          ),
        ),
        elevation: 0,
        height: 72,
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: colors.surface,
        indicatorColor: colors.brandSoft,
        selectedIconTheme: IconThemeData(color: colors.brand),
        unselectedIconTheme: IconThemeData(color: colors.textSecondary),
        selectedLabelTextStyle: TextStyle(
          color: colors.brand,
          fontWeight: FontWeight.w600,
        ),
        unselectedLabelTextStyle: TextStyle(color: colors.textSecondary),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: colors.appBackground,
        foregroundColor: colors.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: colors.subtle,
        hintStyle: TextStyle(color: colors.textMuted),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 16,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: colors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: colors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: colors.brand, width: 1.5),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(48, 48),
          foregroundColor: colors.textSecondary,
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: colors.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: colors.surface,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
      ),
    );
  }
}

extension AppThemeContext on BuildContext {
  AppColors get colors =>
      Theme.of(this).extension<AppColors>() ?? AppColors.light;
}
