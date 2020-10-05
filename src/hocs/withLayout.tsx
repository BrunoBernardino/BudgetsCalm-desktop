import React, { Component } from 'react';
import { RxDatabase, isRxDatabase } from 'rxdb';
import moment from 'moment';
import { remote } from 'electron';

import Notification from '../components/Notification';
import DB from '../lib/db';

import * as T from '../lib/types';

interface LayoutProps {}
interface LayoutState {
  isLoading: boolean;
  isShowingNotification: boolean;
  notificationMessage: string;
  monthInView: string;
  lastSyncDate: string;
  budgets: T.Budget[];
  expenses: T.Expense[];
  currency: string;
}

const notificationTimeoutInMS = 10 * 1000;
const reloadTimeoutInMS = 60 * 1000;

const withLayout: any = (WrappedComponent: any, sharedOptions: any) => {
  class LayoutComponent extends Component<LayoutProps, LayoutState> {
    notificationTimeout = null;

    reloadTimeout = null;

    db: RxDatabase | null = null;

    constructor(props: LayoutProps) {
      super(props);

      this.db = sharedOptions.db;

      this.state = {
        isLoading: true,
        isShowingNotification: false,
        notificationMessage: '',
        monthInView: moment().format('YYYY-MM'),
        lastSyncDate: '',
        budgets: [],
        expenses: [],
        currency: 'USD',
      };
    }

    componentDidMount() {
      this.loadData();
    }

    componentWillUnmount() {
      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
      }

      if (this.reloadTimeout) {
        clearTimeout(this.reloadTimeout);
      }

      this.cleanupDB();
    }

    cleanupDB = async () => {
      if (sharedOptions.db) {
        try {
          sharedOptions.db._subs.forEach((subscriber: any) =>
            subscriber.unsubscribe(),
          );
          await sharedOptions.db.destroy();
          sharedOptions.db = null;
          this.db = null;
        } catch (error) {
          console.log('Error cleaning up DB');
          console.log(error);
        }
      }
    };

    showAlert = (title: string, message: string) => {
      remote.dialog.showMessageBoxSync({
        type: 'info',
        title,
        message,
        buttons: ['OK'],
      });
    };

    showNotification = (message: string) => {
      this.setState({
        isShowingNotification: true,
        notificationMessage: message,
      });

      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
      }

      this.notificationTimeout = setTimeout(
        () =>
          this.setState({
            isShowingNotification: false,
            notificationMessage: '',
          }),
        notificationTimeoutInMS,
      );
    };

    hideNotifications = () => {
      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
      }

      this.setState({
        isShowingNotification: false,
        notificationMessage: '',
      });
    };

    ensureDBConnection = async (forceReload = false) => {
      if (
        !isRxDatabase(this.db) ||
        !this.db ||
        !this.db.budgets ||
        !this.db.expenses
      ) {
        forceReload = true;
      }

      if (forceReload) {
        await this.cleanupDB();

        if (!sharedOptions.db) {
          sharedOptions.db = await DB.connect();
        }

        this.db = sharedOptions.db;
      }
    };

    loadData = async (
      options: {
        monthToLoad?: string;
        forceReload?: boolean;
        isComingFromEmptyState?: boolean;
      } = {},
    ) => {
      const { monthToLoad, forceReload, isComingFromEmptyState } = options;

      if (this.reloadTimeout) {
        clearTimeout(this.reloadTimeout);
      }

      const currency = this.getSetting('currency');

      await this.ensureDBConnection(forceReload);

      const { monthInView } = this.state;

      this.showLoading();

      this.setState({
        budgets: [],
        expenses: [],
        currency,
      });

      const budgets = await DB.fetchBudgets(
        this.db,
        monthToLoad || monthInView,
      );
      const expenses = await DB.fetchExpenses(
        this.db,
        monthToLoad || monthInView,
      );

      // If this is for the current or next month and there are no budgets, create budgets based on the previous/current month.
      if (budgets.length === 0 && !isComingFromEmptyState) {
        const currentMonth = moment().format('YYYY-MM');
        const nextMonth = moment().add(1, 'month').format('YYYY-MM');
        const previousMonth = moment().subtract(1, 'month').format('YYYY-MM');

        if (
          (monthToLoad && monthToLoad === nextMonth) ||
          (!monthToLoad && monthInView === nextMonth)
        ) {
          await DB.copyBudgets(this.db, currentMonth, nextMonth);
          await this.loadData({ monthToLoad, isComingFromEmptyState: true });
          return;
        }

        if (
          (monthToLoad && monthToLoad === currentMonth) ||
          (!monthToLoad && monthInView === currentMonth)
        ) {
          await DB.copyBudgets(this.db, previousMonth, currentMonth);
          await this.loadData({ monthToLoad, isComingFromEmptyState: true });
          return;
        }
      }

      const lastSyncDate = DB.fetchSetting('lastSyncDate');

      this.setState(
        {
          budgets,
          expenses,
          lastSyncDate,
        },
        this.hideLoading,
      );

      this.reloadTimeout = setTimeout(() => this.loadData(), reloadTimeoutInMS);
    };

    showLoading = () => {
      this.setState({ isLoading: true });
    };

    hideLoading = () => {
      this.setState({ isLoading: false });
    };

    changeMonthInView = async (newMonth: string) => {
      const nextMonth = moment().add(1, 'month').format('YYYY-MM');

      if (newMonth > nextMonth) {
        this.showAlert('Warning', 'Cannot travel further into the future!');
        return;
      }

      this.setState({ monthInView: newMonth });

      await this.loadData({ monthToLoad: newMonth });
    };

    saveBudget = async (budget: T.Budget) => {
      try {
        await this.ensureDBConnection();
        await DB.saveBudget(this.db, budget);
        await this.loadData();
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    saveExpense = async (expense: T.Expense) => {
      try {
        await this.ensureDBConnection();
        await DB.saveExpense(this.db, expense);
        await this.loadData();
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    getSetting = (settingName: T.SettingOption) => {
      return DB.fetchSetting(settingName);
    };

    saveSetting = async (setting: T.Setting) => {
      try {
        await this.ensureDBConnection();
        DB.saveSetting(setting);
        await this.loadData({ forceReload: true });
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    deleteBudget = async (budgetId: string) => {
      try {
        await this.ensureDBConnection();
        await DB.deleteBudget(this.db, budgetId);
        await this.loadData();
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    deleteExpense = async (expenseId: string) => {
      try {
        await this.ensureDBConnection();
        await DB.deleteExpense(this.db, expenseId);
        await this.loadData();
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    importData = async (
      replaceData: boolean,
      budgets: T.Budget[],
      expenses: T.Expense[],
    ) => {
      try {
        await this.ensureDBConnection();
        await DB.importData(this.db, replaceData, budgets, expenses);
        await this.loadData({ forceReload: true });
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    exportAllData = async () => {
      try {
        await this.loadData({ forceReload: true });
        return DB.exportAllData(this.db);
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return { budgets: [], expenses: [] };
      }
    };

    deleteAllData = async () => {
      try {
        await this.loadData({ forceReload: true });
        await DB.deleteAllData(this.db);
        await this.db.remove();
        await this.loadData({ forceReload: true });
        return true;
      } catch (error) {
        this.showAlert('Error', error.message);
        console.log(error);
        return false;
      }
    };

    render = () => {
      const {
        isLoading,
        isShowingNotification,
        notificationMessage,
        monthInView,
        lastSyncDate,
        budgets,
        expenses,
        currency,
      } = this.state;

      return (
        <>
          <Notification
            isShowing={isShowingNotification}
            message={notificationMessage}
            onClick={this.hideNotifications}
          />
          <WrappedComponent
            {...this.props}
            isLoading={isLoading}
            monthInView={monthInView}
            lastSyncDate={lastSyncDate}
            budgets={budgets}
            expenses={expenses}
            currency={currency}
            loadData={this.loadData}
            showLoading={this.showLoading}
            hideLoading={this.hideLoading}
            showAlert={this.showAlert}
            showNotification={this.showNotification}
            hideNotifications={this.hideNotifications}
            changeMonthInView={this.changeMonthInView}
            saveBudget={this.saveBudget}
            saveExpense={this.saveExpense}
            getSetting={this.getSetting}
            saveSetting={this.saveSetting}
            deleteBudget={this.deleteBudget}
            deleteExpense={this.deleteExpense}
            importData={this.importData}
            exportAllData={this.exportAllData}
            deleteAllData={this.deleteAllData}
          />
        </>
      );
    };
  }

  return LayoutComponent;
};

export default withLayout;
