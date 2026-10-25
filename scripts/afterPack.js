const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  // Only run on macOS
  if (process.platform !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // Clean up Apple Double files that cause signing issues on external drives
  console.log("🧹 Cleaning Apple Double files before signing...");
  try {
    // More aggressive cleaning - clean the entire app bundle specifically
    execSync(`find "${appPath}" -name "._*" -delete`, { stdio: "inherit" });
    execSync(`find "${appPath}" -name ".DS_Store" -delete`, {
      stdio: "inherit",
    });
    execSync(`find "${context.appOutDir}" -name "._*" -delete`, {
      stdio: "inherit",
    });
    execSync(`find "${context.appOutDir}" -name ".DS_Store" -delete`, {
      stdio: "inherit",
    });

    // Remove extended attributes
    execSync(`xattr -cr "${appPath}" 2>/dev/null || true`, {
      stdio: "inherit",
    });
    execSync(`xattr -cr "${context.appOutDir}" 2>/dev/null || true`, {
      stdio: "inherit",
    });

    // Specifically target the problematic Electron Framework
    const frameworkPath = path.join(
      appPath,
      "Contents/Frameworks/Electron Framework.framework",
    );
    if (require("fs").existsSync(frameworkPath)) {
      execSync(`find "${frameworkPath}" -name "._*" -delete`, {
        stdio: "inherit",
      });
      execSync(`xattr -cr "${frameworkPath}" 2>/dev/null || true`, {
        stdio: "inherit",
      });
    }

    console.log("✅ Cleaned Apple Double files successfully");
  } catch (error) {
    console.warn("⚠️ Warning: Failed to clean some files:", error.message);
  }

  // Check if we have a proper signing certificate (env names used by scripts/release.sh
  // and electron-builder respectively)
  if (
    process.env.MAC_SIGNING_IDENTITY ||
    process.env.CSC_NAME ||
    process.env.CSC_LINK
  ) {
    console.log("✅ Using Developer ID certificate for signing");
    return; // electron-builder will handle the signing
  }

  // Only apply ad-hoc signing if no certificate is available
  console.log(
    "⚠️  No signing certificate found, applying ad-hoc signature to:",
    appPath,
  );

  try {
    // Apply ad-hoc signing with --deep flag
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: "inherit",
    });

    // Verify the signature
    const result = execSync(`codesign -dvv "${appPath}" 2>&1`, {
      encoding: "utf8",
    });
    if (result.includes("Sealed Resources")) {
      console.log("✅ Ad-hoc signing successful!");
    } else {
      console.warn("⚠️ Warning: Sealed resources not found in signature");
    }
  } catch (error) {
    console.error("Failed to apply ad-hoc signature:", error.message);
    throw error;
  }
};
