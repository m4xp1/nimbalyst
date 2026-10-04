import javax.inject.Inject
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

// The google-services plugin hard-fails when app/google-services.json is absent
// (it is gitignored, so it is missing in CI and on most dev machines). Apply it
// only when the config file is present. NotificationManager already no-ops when
// Firebase is unconfigured, so a JSON-less build is green and push stays inert.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

android {
    namespace = "com.nimbalyst.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nimbalyst.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    // Release signing is configured only when a keystore is provided via env or
    // gradle properties (e.g. CI secrets). With no keystore the release build is
    // simply unsigned, so a secret-less build (CI without the keystore secret, or
    // a fresh clone) still succeeds. No secrets ever live in source.
    val keystorePath = System.getenv("NIMBALYST_ANDROID_KEYSTORE")
        ?: (project.findProperty("nimbalyst.android.keystore") as String?)
    val hasReleaseKeystore = !keystorePath.isNullOrBlank() && file(keystorePath).exists()

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("NIMBALYST_ANDROID_KEYSTORE_PASSWORD")
                    ?: (project.findProperty("nimbalyst.android.keystorePassword") as String?)
                keyAlias = System.getenv("NIMBALYST_ANDROID_KEY_ALIAS")
                    ?: (project.findProperty("nimbalyst.android.keyAlias") as String?)
                keyPassword = System.getenv("NIMBALYST_ANDROID_KEY_PASSWORD")
                    ?: (project.findProperty("nimbalyst.android.keyPassword") as String?)
            }
        }
    }

    buildTypes {
        release {
            // Keep minification off: SyncProtocol relies on Gson reflection and Room
            // codegen would need extensive keep rules under R8. Signed != minified.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    val firebaseBom = platform("com.google.firebase:firebase-bom:33.7.0")

    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation(firebaseBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-process:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.room:room-runtime:2.7.2")
    implementation("androidx.room:room-ktx:2.7.2")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.posthog:posthog-android:3.8.2")
    ksp("androidx.room:room-compiler:2.7.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.room:room-testing:2.7.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Copies a prebuilt web bundle (dist-transcript/, dist-editor/) into a
// generated asset root under `<bundleName>/`, so the WebViews load it from
// file:///android_asset/<bundleName>/. Registered per variant through the
// Variant API; AGP 9 rejects Provider-backed sourceSets.assets.srcDir entries.
abstract class SyncWebBundleTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val bundleDir: DirectoryProperty

    @get:Input
    abstract val bundleName: Property<String>

    @get:Input
    abstract val buildCommand: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun sync() {
        val source = bundleDir.get().asFile
        if (!source.exists()) {
            throw GradleException(
                "Web bundle not found at $source. Run `${buildCommand.get()}` first."
            )
        }
        fs.sync {
            from(source)
            into(outputDir.dir(bundleName))
        }
    }
}

androidComponents {
    onVariants { variant ->
        val suffix = variant.name.replaceFirstChar { it.uppercase() }
        val syncTranscriptAssets = tasks.register<SyncWebBundleTask>("sync${suffix}TranscriptAssets") {
            bundleDir.set(layout.projectDirectory.dir("../dist-transcript"))
            bundleName.set("transcript-dist")
            buildCommand.set("npm run build:transcript --prefix packages/android")
        }
        val syncEditorAssets = tasks.register<SyncWebBundleTask>("sync${suffix}EditorAssets") {
            bundleDir.set(layout.projectDirectory.dir("../dist-editor"))
            bundleName.set("editor-dist")
            buildCommand.set("npm run build:editor --prefix packages/android")
        }
        variant.sources.assets?.let { assets ->
            assets.addGeneratedSourceDirectory(syncTranscriptAssets, SyncWebBundleTask::outputDir)
            assets.addGeneratedSourceDirectory(syncEditorAssets, SyncWebBundleTask::outputDir)
        }
    }
}
