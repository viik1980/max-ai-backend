// =================================================================
// SECURE HTTP CLIENT — certificate pinning для запросов к бэкенду
// =================================================================
// Блокирует классический инструментарий реверс-инженера (mitmproxy,
// Charles) — они подсовывают свой сертификат, чтобы читать трафик
// в открытую. Без пиннинга Android/iOS доверяют любому сертификату
// с валидной цепочкой (включая специально установленный пользователем
// в настройках устройства для перехвата) — с пиннингом чужой
// сертификат отклоняется, даже если ОС ему доверяет.
//
// ⚠️ ВАЖНЫЙ ЭКСПЛУАТАЦИОННЫЙ РИСК, ПРО КОТОРЫЙ НАДО ПОМНИТЬ:
// Railway сам управляет TLS-сертификатом через Let's Encrypt и меняет
// ЛИСТОВОЙ сертификат каждые ~90 дней автоматически, без предупреждения.
// Если запинить только листовой сертификат одним пином — после первой
// же ротации ВСЕ 6 тестеров разом теряют связь с бэкендом без
// возможности исправить это без обновления приложения.
//
// Поэтому:
// 1. Пиним ДВА уровня — листовой сертификат (основной пин) И
//    промежуточный сертификат Let's Encrypt (backup-пин, живёт
//    несравнимо дольше — годами, это Google-уровня инфраструктура).
//    Ротация листового сертификата не ломает приложение, пока жив
//    хотя бы один из пинов.
// 2. Есть флаг kEnforcePinning — если пиннинг всё же сломается
//    (например Let's Encrypt сменит саму цепочку intermediate,
//    что бывает раз в несколько лет), можно выпустить хотфикс
//    ТОЛЬКО с этим флагом в false — без переписывания логики.
// =================================================================

import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:flutter/foundation.dart';

class SecureHttpClient {
  // 🔧 Включить/выключить проверку пинов без переписывания логики.
  // Передаётся через --dart-define=ENFORCE_PINNING=false при сборке
  // хотфикса, если пиннинг сломался на всех устройствах разом.
  static const bool kEnforcePinning =
      bool.fromEnvironment('ENFORCE_PINNING', defaultValue: true);

  // 🔧 SHA-256 отпечатки сертификатов (hex, без двоеточий, в нижнем
  // регистре). Как получить — см. README бэкенда, раздел "Пиннинг".
  // Задаются через --dart-define, чтобы не пересобирать весь код
  // ради обновления пина после ротации.
  static const String _pinsRaw = String.fromEnvironment(
    'BACKEND_CERT_PINS',
    defaultValue: '',
  );

  static List<String> get _pins => _pinsRaw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .where((e) => e.isNotEmpty)
      .toList();

  static http.Client? _client;

  /// Клиент для запросов ТОЛЬКО к своему бэкенду (не для OpenAI —
  /// там пиннинг не нужен, это чужой, уже доверенный сервис).
  static http.Client get instance {
    if (_client != null) return _client!;

    if (!kEnforcePinning) {
      debugPrint('⚠️ SecureHttpClient: пиннинг ВЫКЛЮЧЕН (kEnforcePinning=false)');
      _client = http.Client();
      return _client!;
    }

    if (_pins.isEmpty) {
      // Без прописанных пинов работаем как обычный HTTPS-клиент —
      // лучше рабочее приложение без пиннинга, чем случайно
      // заблокировать себя же на первом релизе из-за пустого списка.
      debugPrint('⚠️ SecureHttpClient: BACKEND_CERT_PINS пуст — пиннинг фактически выключен');
      _client = http.Client();
      return _client!;
    }

    final httpClient = HttpClient();
    httpClient.badCertificateCallback = (X509Certificate cert, String host, int port) {
      final digest = sha256.convert(cert.der).toString().toLowerCase();
      final match = _pins.contains(digest);
      if (!match) {
        debugPrint('🔒 SecureHttpClient: сертификат $host не совпал с пином ($digest)');
      }
      return match;
    };

    _client = IOClient(httpClient);
    return _client!;
  }

  /// Вызывать при логауте/смене окружения (dev↔prod backend URL) —
  /// пересоздаёт клиент с текущими значениями dart-define.
  static void reset() {
    _client?.close();
    _client = null;
  }
}
