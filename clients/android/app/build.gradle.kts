plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val generatedClientAssets = layout.buildDirectory.dir("generated/client-assets")
val prepareClientUi by tasks.registering(Exec::class) {
    inputs.dir(rootProject.file("../ui"))
    inputs.dir(rootProject.file("../node_modules/@xterm"))
    outputs.dir(generatedClientAssets)
    commandLine(
        "node",
        rootProject.file("../prepare-client-ui.js").absolutePath,
        generatedClientAssets.get().asFile.absolutePath,
    )
}

android {
    namespace = "cn.remoteterminal.app"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "cn.remoteterminal.app"; minSdk = 26; targetSdk = 35; versionCode = 5; versionName = "0.3.0"
        buildConfigField("String", "DEFAULT_RELAY_URL", "\"wss://webclaude.xmu-zss.cn\"")
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    sourceSets.getByName("main").assets.srcDir(generatedClientAssets)
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = true; checkReleaseBuilds = true }
}

tasks.named("preBuild").configure { dependsOn(prepareClientUi) }
