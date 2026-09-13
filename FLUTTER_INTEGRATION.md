# Подключение Firebase Auth + пиннинга во Flutter-приложении

## 1. pubspec.yaml — добавить зависимости

```yaml
dependencies:
  firebase_core: ^3.6.0
  firebase_auth: ^5.3.1
  crypto: ^3.0.3
```
(версии ориентировочные — `flutter pub outdated` подскажет актуальные на момент сборки)

## 2. Подключить Firebase к проекту (если ещё не подключён как runtime SDK)

Firebase App Distribution, которым вы пользуетесь для раздачи тестерам, — это
отдельный Gradle-плагин, он НЕ означает, что в приложении уже есть Firebase SDK
для рантайма. Нужно:

```bash
dart pub global activate flutterfire_cli
flutterfire configure
```

Выбрать тот же Firebase-проект, что уже используется для App Distribution.
Команда сама положит `google-services.json` (Android) и сгенерирует
`lib/firebase_options.dart`.

## 3. Включить анонимный вход

Firebase Console → Authentication → Sign-in method → Anonymous → Enable.
Без этого шага `signInAnonymously()` будет падать с `operation-not-allowed`.

## 4. main.dart — добавить инициализацию ПЕРЕД runApp

```dart
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  runApp(const MyApp()); // как было
}
```

## 5. Получить пины сертификата Railway-бэкенда

Замени `<твой-домен>` на реальный домен из Railway (Settings → Networking):

```bash
# Листовой сертификат (основной пин) — SHA-256
openssl s_client -connect <твой-домен>:443 -servername <твой-домен> </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'

# Промежуточный сертификат Let's Encrypt (backup-пин) — SHA-256
openssl s_client -connect <твой-домен>:443 -servername <твой-домен> -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN/{i++}i==2' \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'
```

Получишь два hex-отпечатка — оба идут в один `--dart-define` через запятую.

## 6. Команда сборки

```bash
flutter build apk --release \
  --dart-define=BACKEND_BASE_URL=https://<твой-домен> \
  --dart-define=BACKEND_CERT_PINS=<отпечаток_листового>,<отпечаток_intermediate> \
  --dart-define=ENFORCE_PINNING=true
```

Если после ротации сертификата приложение вдруг перестало соединяться —
экстренный хотфикс: пересобрать с `--dart-define=ENFORCE_PINNING=false`,
без изменения кода, пока не соберёшь новые пины.

## 7. Использование в коде

`ai_service.dart` (следующий блок) уже написан под эти два новых файла:
- `MaxAuth.instance.getIdToken()` — токен для заголовка `Authorization`.
- `SecureHttpClient.instance` — клиент вместо голого `http.post`/`http.Client()`
  для запросов к своему бэкенду (НЕ для fallback-запросов к OpenAI — тот
  идёт обычным `http`, пиннинг там не нужен и не настроен).
