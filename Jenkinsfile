pipeline {
    agent any

    options {
        timeout(time: 60, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '15'))
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                // Refresh tracked files so existing workspaces apply .gitattributes.
                // Git checkout can otherwise retain unchanged files with old CRLF endings.
                bat 'git checkout-index --force --all'
            }
        }

        stage('Install Dependencies') {
            steps {
                bat 'npm ci'
            }
        }

        stage('Install Playwright Browsers') {
            steps {
                bat 'npx playwright install chromium'
            }
        }

        stage('Check Code') {
            steps {
                bat 'npm run check'
            }
        }

        stage('Run Playwright Tests') {
            steps {
                bat 'npm test'
            }
        }
    }

    post {
        always {
            archiveArtifacts(
                artifacts: 'playwright-report/**, test-results/**',
                allowEmptyArchive: true
            )
        }

        success {
            echo 'Playwright tests passed.'
        }

        failure {
            echo 'Pipeline failed. Check the failed stage; browser tests may have been skipped.'
        }
    }
}
