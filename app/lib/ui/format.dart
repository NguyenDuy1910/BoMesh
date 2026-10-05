/// How the app writes times, sizes and counts. Every screen uses these so a
/// date reads the same everywhere.
library;

const _months = [
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

DateTime? parseTime(Object? value) => value is DateTime
    ? value.toLocal()
    : DateTime.tryParse('${value ?? ''}')?.toLocal();

String _two(int value) => value.toString().padLeft(2, '0');

/// "just now", "8 min ago", "6h ago", "yesterday", "3 days ago", "12 Sep",
/// "12 Sep 2024". Empty when [value] is not a time.
String relativeTime(Object? value, {DateTime? now}) {
  final time = parseTime(value);
  if (time == null) return '';
  final current = now ?? DateTime.now();
  final elapsed = current.difference(time);
  if (elapsed.isNegative || elapsed.inSeconds < 60) return 'just now';
  if (elapsed.inMinutes < 60) return '${elapsed.inMinutes} min ago';
  final today = DateTime(current.year, current.month, current.day);
  final day = DateTime(time.year, time.month, time.day);
  final days = today.difference(day).inDays;
  if (days == 0) return '${elapsed.inHours}h ago';
  if (days == 1) return 'yesterday';
  if (days < 7) return '$days days ago';
  return calendarDate(time, now: current);
}

/// "12 Sep", or "12 Sep 2024" outside the current year.
String calendarDate(Object? value, {DateTime? now}) {
  final time = parseTime(value);
  if (time == null) return '';
  final year = (now ?? DateTime.now()).year;
  final base = '${time.day} ${_months[time.month - 1]}';
  return time.year == year ? base : '$base ${time.year}';
}

/// "9:12" today, otherwise [relativeTime].
String clockOrRelative(Object? value, {DateTime? now}) {
  final time = parseTime(value);
  if (time == null) return '';
  final current = now ?? DateTime.now();
  final sameDay =
      time.year == current.year &&
      time.month == current.month &&
      time.day == current.day;
  return sameDay
      ? '${time.hour}:${_two(time.minute)}'
      : relativeTime(time, now: current);
}

/// "16:20, 3 Oct" — a precise moment for detail screens.
String exactTime(Object? value) {
  final time = parseTime(value);
  if (time == null) return '';
  return '${time.hour}:${_two(time.minute)}, ${calendarDate(time)}';
}

/// "512 B", "15 KB", "4.2 MB".
String readableBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  if (bytes < 1024 * 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
}

/// "1,284".
String groupedNumber(int value) {
  final digits = value.abs().toString();
  final buffer = StringBuffer(value < 0 ? '-' : '');
  for (var index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 == 0) buffer.write(',');
    buffer.write(digits[index]);
  }
  return buffer.toString();
}

/// "1 item", "271 items", "1,284 questions".
String countOf(int count, String singular, [String? plural]) =>
    '${groupedNumber(count)} ${count == 1 ? singular : plural ?? '${singular}s'}';

/// "+14%", "−3%", or null when there is nothing to compare against.
String? changeLabel(int current, int previous) {
  if (previous <= 0) return null;
  final percent = ((current - previous) * 100 / previous).round();
  if (percent == 0) return 'Same as before';
  return percent > 0 ? '+$percent%' : '−${percent.abs()}%';
}

/// "Pending approval" from "pending_approval".
String sentenceCase(String value) => value.isEmpty
    ? ''
    : '${value[0].toUpperCase()}${value.substring(1).replaceAll('_', ' ')}';
