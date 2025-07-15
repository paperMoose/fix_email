import { authorize } from './auth.js';
import { google } from 'googleapis';
import chalk from 'chalk';

async function checkFilters() {
  console.log(chalk.bold.cyan('\n📋 Checking Gmail Filters\n'));

  try {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    // Get all filters
    const response = await gmail.users.settings.filters.list({
      userId: 'me'
    });

    const filters = response.data.filter || [];
    
    if (filters.length === 0) {
      console.log(chalk.yellow('No filters found in your Gmail account.'));
      return;
    }

    console.log(chalk.green(`Found ${filters.length} active filters:\n`));

    // Get all labels for reference
    const labelsResponse = await gmail.users.labels.list({
      userId: 'me'
    });
    const labels = labelsResponse.data.labels || [];
    const labelMap = {};
    labels.forEach(label => {
      labelMap[label.id] = label.name;
    });

    // Display each filter
    filters.forEach((filter, index) => {
      console.log(chalk.cyan(`Filter ${index + 1}:`));
      
      if (filter.criteria) {
        if (filter.criteria.from) {
          console.log(`  From: ${chalk.yellow(filter.criteria.from)}`);
        }
        if (filter.criteria.to) {
          console.log(`  To: ${chalk.yellow(filter.criteria.to)}`);
        }
        if (filter.criteria.subject) {
          console.log(`  Subject: ${chalk.yellow(filter.criteria.subject)}`);
        }
        if (filter.criteria.query) {
          console.log(`  Query: ${chalk.yellow(filter.criteria.query)}`);
        }
      }

      if (filter.action) {
        if (filter.action.addLabelIds) {
          const labelNames = filter.action.addLabelIds.map(id => labelMap[id] || id);
          console.log(`  Add labels: ${chalk.green(labelNames.join(', '))}`);
        }
        if (filter.action.removeLabelIds) {
          const labelNames = filter.action.removeLabelIds.map(id => {
            if (id === 'INBOX') return 'INBOX';
            return labelMap[id] || id;
          });
          console.log(`  Remove from: ${chalk.red(labelNames.join(', '))}`);
        }
      }
      console.log();
    });

  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('Insufficient Permission')) {
      console.log(chalk.yellow('\nYou need to re-authenticate with the new permissions.'));
      console.log(chalk.yellow('Delete token.json and run the script again.'));
    }
  }
}

checkFilters();