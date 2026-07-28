import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { isRunningInExpoGo } from 'expo';
import * as Location from 'expo-location';

type PermissionState = 'checking' | 'granted' | 'denied';
type Coords = { latitude: number; longitude: number };

// 카카오 개발자 콘솔(https://developers.kakao.com)에서 발급받은 JavaScript 키로 교체
// 콘솔의 "플랫폼 → Web"에 도메인을 등록해야 하고, "제품 설정 → 지도"도 별도로 ON 해야
// SDK가 실제로 지도를 그려준다 (키 발급/도메인 등록과는 완전히 별개의 스위치라 놓치기 쉬움).
const KAKAO_JAVASCRIPT_KEY = '96d9498a594201fdebb379561f361700';

// RN에는 카카오맵 공식 네이티브 라이브러리가 없다. react-native-maps(Google)로 시작했지만
// Expo Go에서는 무료로 되어도 dev build부터는 정식 Google Maps API 키가 필요해져서,
// 대신 WebView 안에서 카카오맵 JS SDK를 HTML로 띄우는 방식으로 전환했다 — 네이티브 지도
// API 키/플랫폼별 빌드 설정 없이 Expo Go에서도 그대로 동작한다는 게 장점이다.
function buildKakaoMapHtml({ latitude, longitude }: Coords) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&libraries=services"></script>
<style>
  body { margin: 0; padding: 0; height: 100%; }
  html { height: 100%; }
  #map { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  // SDK <script> 태그 바로 다음 줄에서 지도를 생성했을 때는 'kakao is not defined'가 나면서
  // 지도가 계속 안 그려졌다. window.onload로 감싸서 SDK 스크립트의 평가가 완전히 끝난
  // 뒤에 kakao.maps를 참조하도록 하니 해결됐다 — 원인이 실행 순서인지 SDK 자체의 지연
  // 초기화인지는 명확하지 않지만, 이 패턴이 실제로 동작한 유일한 조합이었다.
  window.onload = function () {
    console.log('Kakao Map API Loaded');
    if (typeof kakao !== 'undefined' && kakao.maps) {
      console.log('Kakao Maps is available');
      var mapContainer = document.getElementById('map');
      var mapOption = {
        center: new kakao.maps.LatLng(${latitude}, ${longitude}),
        level: 3
      };
      var map = new kakao.maps.Map(mapContainer, mapOption);

      var markerPosition = new kakao.maps.LatLng(${latitude}, ${longitude});
      var marker = new kakao.maps.Marker({ position: markerPosition });
      marker.setMap(map);
    } else {
      console.error('Kakao Maps is not available');
    }
  };
</script>
</body>
</html>`;
}

// expo-notifications는 Expo Go의 Android에서 import되는 "순간" 예외를 던진다 (SDK 53에서
// 원격 푸시 지원이 Expo Go에서 빠지면서, 모듈 로드 시 자동 실행되는 푸시 토큰 등록 코드가
// Platform.OS==='android' && isRunningInExpoGo()일 때 무조건 throw하도록 되어 있음 — 실제
// node_modules 소스에서 확인함). try/catch로 감싸도 모듈을 import하는 시점 자체에서
// 죽어버리기 때문에 막을 수 없다. 그래서 이 상수로 그 조합인지 미리 판별해서, 아래
// 함수들이 해당 조합에서는 아예 expo-notifications를 건드리지 않도록 분기한다.
// (즉, "Android + Expo Go"에서 알림 기능을 테스트하려면 Dev Build가 필수다.)
const notificationsUnsupported = Platform.OS === 'android' && isRunningInExpoGo();

async function requestNotificationPermission(): Promise<PermissionState> {
  if (Platform.OS === 'android') {
    // Android 13(API 33) 미만은 알림 권한이 런타임 권한이 아니라 설치 시 자동 부여된다.
    // PermissionsAndroid.request를 호출해도 시스템이 그냥 무시하므로 여기서 분기 처리.
    if (Platform.Version < 33) {
      return 'granted';
    }
    // expo-notifications 대신 RN 내장 PermissionsAndroid를 쓰는 이유: 위 주석대로
    // Expo Go + Android에서 expo-notifications는 import만 해도 크래시하기 때문에,
    // "권한 요청"이라는 단순한 목적을 위해 그 모듈 자체를 아예 로드하지 않는 것.
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  }

  // iOS/기타 플랫폼은 Expo Go에서도 이 코드가 throw하지 않고 console.warn만 하므로
  // (node_modules 소스 기준) require()로 불러와도 안전하다.
  const Notifications: typeof import('expo-notifications') = require('expo-notifications');
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

// 실기기 dev build에서 테스트 알림 버튼을 눌러도 성공/실패 어느 쪽 Alert도 뜨지 않고
// 그냥 아무 반응이 없는 문제가 있었다. 원인을 좁혀보니 이 함수 안에서 어떤 await가
// 응답을 영영 못 받고 멈춰 있었던 것으로 보였다 (adb 연결 경로 문제로 추정, DEVLOG 참고).
// 그때 "어느 단계에서 멈췄는지"를 알아내기 위해 넣은 게 이 헬퍼이고, 이후에도 향후
// 비슷한 네이티브 브릿지 행잉이 재발하면 무한 대기 대신 눈에 보이는 에러로 드러나도록
// 안전장치 삼아 남겨두었다.
function withTimeout<T>(promise: Promise<T>, label: string, ms = 120000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT at step: ${label}`)), ms)
    ),
  ]);
}

async function sendTestNotification() {
  if (notificationsUnsupported) {
    Alert.alert(
      '지원되지 않음',
      'Android의 Expo Go에서는 알림 발송이 지원되지 않습니다. Development build에서 확인해주세요.'
    );
    return;
  }

  try {
    // require()를 쓰는 이유는 Expo Go 회피용 지연 로딩(위 주석) 때문만이 아니다 —
    // 처음엔 await import('expo-notifications')로 짜고 dev build에서 테스트했더니
    // 이 한 줄에서 몇 분을 기다려도 resolve도 reject도 안 되는 문제가 있었다. 동적
    // import()가 Metro의 별도 청크 요청 경로를 타면서 이 PC/폰 환경(무선 adb)에서
    // 뭔가 막혔던 것으로 추정된다. require()는 이미 로드된 번들 안에서 동기적으로
    // 모듈을 꺼내올 뿐이라 그 경로를 아예 타지 않고, 실제로 바꾸자마자 해결됐다.
    const Notifications: typeof import('expo-notifications') = require('expo-notifications');

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    if (Platform.OS === 'android') {
      await withTimeout(
        Notifications.setNotificationChannelAsync('default', {
          name: '기본 채널',
          importance: Notifications.AndroidImportance.MAX,
        }),
        'setNotificationChannelAsync'
      );
    }

    await withTimeout(
      Notifications.scheduleNotificationAsync({
        content: {
          title: '테스트 알림',
          body: '알림 권한이 정상적으로 동작하고 있습니다.',
        },
        trigger: null,
      }),
      'scheduleNotificationAsync'
    );

    Alert.alert('성공', '알림이 정상적으로 발송되었습니다.');
  } catch (error) {
    // 실기기(무선 adb) 디버깅 중엔 폰 화면 잠금이나 연결 끊김 때문에 logcat을 못 볼 때가
    // 많았다. 실패를 콘솔에만 흘려보내지 않고 Alert로 직접 띄워야 무슨 일이 있었는지
    // 그 자리에서 바로 알 수 있었다 — 이 앱의 목적 자체가 "권한/기능이 실제로 되는지
    // 눈으로 확인하는 것"이라 조용히 실패하는 건 의미가 없다.
    Alert.alert('알림 발송 실패', String(error));
  }
}

export default function App() {
  const [notificationStatus, setNotificationStatus] = useState<PermissionState>('checking');
  const [locationStatus, setLocationStatus] = useState<PermissionState>('checking');
  const [coords, setCoords] = useState<Coords | null>(null);
  // 디버깅용으로 남겨둔 카운터. 알림 버튼을 눌러도 성공/실패 Alert가 전혀 안 뜬 적이
  // 있었는데, onPress 자체가 안 불리는 건지(예: 다른 뷰가 터치를 가로챔) vs 내부 로직이
  // 멈춘 건지를 구분하려고 추가했다. 화면 위에서 바로 확인 가능해서 계속 두었다.
  const [pressCount, setPressCount] = useState(0);

  useEffect(() => {
    (async () => {
      setNotificationStatus(await requestNotificationPermission());
    })();

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setLocationStatus(status === 'granted' ? 'granted' : 'denied');

      if (status === 'granted') {
        try {
          // 앱 권한은 허용됐어도 기기 시스템 설정에서 위치(GPS) 서비스 자체가 꺼져 있으면
          // getCurrentPositionAsync가 응답 없이 늘어지거나 모호한 에러를 던진다. 그러면
          // 지도 영역이 이유도 모른 채 로딩 스피너로 영원히 멈춰 있는 것처럼 보이므로,
          // "권한 거부"와 "위치 서비스 꺼짐"을 구분해서 바로 원인을 알려주도록 분리했다.
          const servicesEnabled = await Location.hasServicesEnabledAsync();
          if (!servicesEnabled) {
            Alert.alert('위치 서비스 꺼짐', '기기의 위치(GPS) 서비스를 켜주세요.');
            return;
          }

          const position = await Location.getCurrentPositionAsync({});
          setCoords({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        } catch (error) {
          Alert.alert('위치 가져오기 실패', String(error));
        }
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>홈 화면</Text>

      <View style={styles.row}>
        <Text style={styles.label}>알림 권한</Text>
        <PermissionBadge status={notificationStatus} />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>위치 권한</Text>
        <PermissionBadge status={locationStatus} />
      </View>

      <Text>눌림 횟수: {pressCount}</Text>

      <Pressable
        style={styles.button}
        onPress={() => {
          setPressCount((n) => n + 1);
          sendTestNotification();
        }}
      >
        <Text style={styles.buttonText}>테스트 알림 보내기</Text>
      </Pressable>

      <View style={styles.mapContainer}>
        {coords ? <LocationMap coords={coords} /> : <ActivityIndicator />}
      </View>

      <StatusBar style="auto" />
    </View>
  );
}

function PermissionBadge({ status }: { status: PermissionState }) {
  if (status === 'checking') {
    return <ActivityIndicator />;
  }
  return (
    <Text style={status === 'granted' ? styles.granted : styles.denied}>
      {status === 'granted' ? '허용됨' : '거부됨'}
    </Text>
  );
}

// Kakao 지도가 계속 빈 화면이었을 때 WebView 안쪽 콘솔(에러 포함)을 볼 방법이 마땅치
// 않았다 — adb logcat은 폰 화면 잠금/무선 디버깅 연결 끊김 때문에 계속 확인이 끊겼고,
// 그마저도 SDK 실패는 네트워크 레벨이라 눈에 잘 안 띄는 형태로 찍혔다. 그래서 WebView
// 내부의 console.log/error를 가로채 postMessage로 RN 쪽에 그대로 전달하고, 화면 위에
// 오버레이로 띄워서 adb 없이 앱만 보고도 원인을 바로 알 수 있게 만들었다.
const forwardConsoleScript = `(function () {
  var send = function (level, args) {
    window.ReactNativeWebView.postMessage(level + ': ' + Array.prototype.join.call(args, ' '));
  };
  var originalLog = console.log;
  var originalError = console.error;
  console.log = function () { send('LOG', arguments); originalLog.apply(console, arguments); };
  console.error = function () { send('ERROR', arguments); originalError.apply(console, arguments); };
})();
true;`;

// react-native-webview는 react-native-maps와 마찬가지로 웹 구현이 없다. 문제는 단순히
// "웹에서 동작 안 함" 정도가 아니라, 파일 최상단에서 `import WebView from
// 'react-native-webview'`처럼 정적으로 import하면 Metro가 웹 번들을 만들 때 그 모듈을
// 즉시 평가하면서 웹 번들 전체가 크래시했다 (실제로 겪음: codegenNativeComponent 관련
// TypeError로 웹 프리뷰 전체가 안 뜸). 컴포넌트가 웹에서 렌더링되지 않더라도 import 자체가
// 문제이므로, Platform.OS !== 'web'일 때만 useEffect 안에서 require()로 지연 로딩해서
// 웹 번들러가 이 모듈을 평가할 일 자체를 없앴다.
function LocationMap({ coords }: { coords: Coords }) {
  const [webviewModule, setWebviewModule] = useState<typeof import('react-native-webview') | null>(
    null
  );
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    setWebviewModule(require('react-native-webview'));
  }, []);

  if (Platform.OS === 'web') {
    return <Text style={styles.mapFallback}>지도는 웹에서 지원되지 않습니다.</Text>;
  }

  if (!webviewModule) {
    return <ActivityIndicator />;
  }

  const WebView = webviewModule.default;

  return (
    <View style={styles.map}>
      <WebView
        style={styles.map}
        originWhitelist={['*']}
        // javaScriptEnabled/domStorageEnabled는 react-native-webview 기본값에 맡기지 않고
        // 명시적으로 켰다. 이걸 빼먹었을 때 카카오맵 SDK가 로드는 됐다는 로그까지 나오고도
        // window.kakao를 끝내 만들지 않는 채로 조용히 실패한 적이 있어서 (SDK가 내부적으로
        // storage에 접근하다 막히는 것으로 추정), 원인 불문하고 항상 켜두기로 했다.
        javaScriptEnabled
        domStorageEnabled
        // source에 baseUrl을 절대 주지 마라. 한 번은 카카오 콘솔에 등록한 도메인과 정확히
        // 맞추려고 baseUrl: 'http://localhost:8081'을 지정했는데, 그래도 지도가 안 떠서
        // 한참을 헤맸다. baseUrl을 아예 안 주고(=WebView 기본 origin을 그대로 쓰고) 카카오
        // 콘솔 쪽 Web 플랫폼 도메인/지도 제품 활성화만 맞추는 조합이 실제로 동작한 유일한
        // 설정이었다 — baseUrl과 콘솔 등록 도메인을 억지로 맞추려 하지 말 것.
        source={{ html: buildKakaoMapHtml(coords) }}
        injectedJavaScript={forwardConsoleScript}
        onMessage={(event: { nativeEvent: { data: string } }) =>
          setLogs((prev) => [...prev, event.nativeEvent.data])
        }
        onError={(event: { nativeEvent: { description?: string } }) =>
          setLogs((prev) => [...prev, 'WebView onError: ' + event.nativeEvent.description])
        }
      />
      {logs.length > 0 && (
        <View style={styles.logOverlay}>
          {logs.map((log, i) => (
            <Text key={i} style={styles.logText}>
              {log}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: 220,
  },
  label: {
    fontSize: 16,
  },
  granted: {
    color: '#2e7d32',
    fontWeight: '600',
  },
  denied: {
    color: '#c62828',
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  mapContainer: {
    // height는 반드시 고정값이어야 한다 — WebView(및 그 안의 카카오 지도 div)는 부모 체인
    // 어딘가에 퍼센트가 아닌 실제 픽셀 높이가 없으면 0px로 접혀서 아무것도 안 그려진다.
    width: '90%',
    height: 300,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#eee',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  mapFallback: {
    color: '#666',
  },
  logOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.75)',
    padding: 8,
    maxHeight: 150,
  },
  logText: {
    color: '#0f0',
    fontSize: 10,
  },
});
